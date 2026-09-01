import AppKit
import Foundation
import Vision
import CoreML

private struct ImageInput: Decodable {
    let pageNum: Int
    let path: String
}

private struct HelperRequest: Decodable {
    let images: [ImageInput]
    let recognitionLanguages: [String]?
    let recognitionLevel: String?
    let usesLanguageCorrection: Bool?
    let numWorkers: Int?
}

private struct TextItem: Encodable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let confidence: Double
}

private struct PageOutput: Encodable {
    let pageNum: Int
    let width: Double
    let height: Double
    let text: String
    let textItems: [TextItem]
}

private struct HelperOutput: Encodable {
    let pages: [PageOutput]
}

private enum HelperError: LocalizedError {
    case invalidImage(String)
    case unsupportedLanguages([String])

    var errorDescription: String? {
        switch self {
        case .invalidImage(let path):
            return "Unable to decode OCR image: \(path)"
        case .unsupportedLanguages(let languages):
            return "Apple Vision does not support requested OCR languages: \(languages.joined(separator: ", "))"
        }
    }
}

private func loadCGImage(path: String) throws -> CGImage {
    guard let image = NSImage(contentsOfFile: path) else {
        throw HelperError.invalidImage(path)
    }
    var proposedRect = CGRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
        throw HelperError.invalidImage(path)
    }
    return cgImage
}

private func preferNeuralEngine(_ request: VNRequest) {
    if #available(macOS 14.0, *), let stages = try? request.supportedComputeStageDevices {
        for (stage, devices) in stages {
            if let neuralEngine = devices.first(where: { device in
                if case .neuralEngine = device { return true }
                return false
            }) {
                request.setComputeDevice(neuralEngine, for: stage)
            }
        }
    }
}

private func recognize(_ input: ImageInput, requestConfig: HelperRequest) throws -> PageOutput {
    let cgImage = try loadCGImage(path: input.path)
    let pixelWidth = Double(cgImage.width)
    let pixelHeight = Double(cgImage.height)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = requestConfig.recognitionLevel == "fast" ? .fast : .accurate
    request.usesLanguageCorrection = requestConfig.usesLanguageCorrection ?? true
    preferNeuralEngine(request)

    let requestedLanguages = requestConfig.recognitionLanguages ?? []
    if requestedLanguages.isEmpty {
        if #available(macOS 12.0, *) {
            request.automaticallyDetectsLanguage = true
        }
    } else {
        let supported = try request.supportedRecognitionLanguages()
        let unsupported = requestedLanguages.filter { !supported.contains($0) }
        if !unsupported.isEmpty {
            throw HelperError.unsupportedLanguages(unsupported)
        }
        request.recognitionLanguages = requestedLanguages
    }

    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
    try handler.perform([request])

    let items = (request.results ?? []).compactMap { observation -> TextItem? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return TextItem(
            text: candidate.string,
            x: box.minX * pixelWidth,
            y: (1.0 - box.maxY) * pixelHeight,
            width: box.width * pixelWidth,
            height: box.height * pixelHeight,
            confidence: Double(candidate.confidence)
        )
    }.sorted {
        if abs($0.y - $1.y) < 2.0 { return $0.x < $1.x }
        return $0.y < $1.y
    }

    return PageOutput(
        pageNum: input.pageNum,
        width: pixelWidth,
        height: pixelHeight,
        text: items.map(\.text).joined(separator: "\n"),
        textItems: items
    )
}

private func run() throws {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let helperRequest = try JSONDecoder().decode(HelperRequest.self, from: input)
    let workers = min(8, max(1, helperRequest.numWorkers ?? 1))
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = workers
    queue.qualityOfService = .userInitiated

    let lock = NSLock()
    var pages: [PageOutput] = []
    var firstError: Error?

    for image in helperRequest.images {
        queue.addOperation {
            guard firstError == nil else { return }
            do {
                let page = try autoreleasepool {
                    try recognize(image, requestConfig: helperRequest)
                }
                lock.lock()
                pages.append(page)
                lock.unlock()
            } catch {
                lock.lock()
                if firstError == nil { firstError = error }
                lock.unlock()
            }
        }
    }
    queue.waitUntilAllOperationsAreFinished()
    if let firstError { throw firstError }

    let output = HelperOutput(pages: pages.sorted { $0.pageNum < $1.pageNum })
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    FileHandle.standardOutput.write(try encoder.encode(output))
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("Vision OCR failed: \(error.localizedDescription)\n".utf8))
    exit(1)
}
