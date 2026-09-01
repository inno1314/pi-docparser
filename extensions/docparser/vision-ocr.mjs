// @ts-check

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HELPER_PATH = fileURLToPath(
  new URL("../../bin/vision-ocr-darwin-universal", import.meta.url),
);
const HELPER_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
const HELPER_STDERR_MAX_BYTES = 64 * 1024;
const VISION_BATCH_MAX_PAGES = 8;

const TESSERACT_TO_VISION_LANGUAGE = new Map([
  ["eng", "en-US"],
  ["deu", "de-DE"],
  ["fra", "fr-FR"],
  ["spa", "es-ES"],
  ["ita", "it-IT"],
  ["por", "pt-BR"],
  ["nld", "nl-NL"],
  ["rus", "ru-RU"],
  ["ukr", "uk-UA"],
  ["pol", "pl-PL"],
  ["tur", "tr-TR"],
  ["jpn", "ja-JP"],
  ["kor", "ko-KR"],
  ["chi_sim", "zh-Hans"],
  ["chi_tra", "zh-Hant"],
]);

export class VisionOcrError extends Error {
  /** @param {string} message @param {unknown} [cause] */
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VisionOcrError";
  }
}

export async function isVisionOcrAvailable() {
  if (process.platform !== "darwin") return false;
  try {
    await access(HELPER_PATH, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** @param {string | undefined} language */
export function visionRecognitionLanguages(language) {
  if (!language) return [];
  return language
    .split(/[+,]/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => TESSERACT_TO_VISION_LANGUAGE.get(entry.toLowerCase()) ?? entry);
}

/** @param {unknown} value @param {string} label */
function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new VisionOcrError(`${label} must be a finite number.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function stringValue(value, label) {
  if (typeof value !== "string") throw new VisionOcrError(`${label} must be a string.`);
  return value;
}

/** @param {unknown} value @param {Set<number>} expectedPages */
function validateHelperOutput(value, expectedPages) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VisionOcrError("Vision OCR helper response must be an object.");
  }
  const rawPages = /** @type {Record<string, unknown>} */ (value).pages;
  if (!Array.isArray(rawPages) || rawPages.length !== expectedPages.size) {
    throw new VisionOcrError("Vision OCR helper returned an unexpected page count.");
  }
  const seen = new Set();
  return rawPages.map((rawPage, pageIndex) => {
    if (typeof rawPage !== "object" || rawPage === null || Array.isArray(rawPage)) {
      throw new VisionOcrError(`Vision OCR page ${pageIndex} must be an object.`);
    }
    const page = /** @type {Record<string, unknown>} */ (rawPage);
    const pageNum = finiteNumber(page.pageNum, `Vision OCR page ${pageIndex}.pageNum`);
    if (!Number.isInteger(pageNum) || !expectedPages.has(pageNum) || seen.has(pageNum)) {
      throw new VisionOcrError(`Vision OCR helper returned unexpected page ${pageNum}.`);
    }
    seen.add(pageNum);
    const width = finiteNumber(page.width, `Vision OCR page ${pageNum}.width`);
    const height = finiteNumber(page.height, `Vision OCR page ${pageNum}.height`);
    if (width <= 0 || height <= 0) {
      throw new VisionOcrError(`Vision OCR page ${pageNum} dimensions must be positive.`);
    }
    if (!Array.isArray(page.textItems) || page.textItems.length > 100_000) {
      throw new VisionOcrError(`Vision OCR page ${pageNum}.textItems is invalid or too large.`);
    }
    const textItems = page.textItems.map((rawItem, itemIndex) => {
      if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) {
        throw new VisionOcrError(`Vision OCR page ${pageNum} item ${itemIndex} must be an object.`);
      }
      const item = /** @type {Record<string, unknown>} */ (rawItem);
      return {
        text: stringValue(item.text, `Vision OCR page ${pageNum} item ${itemIndex}.text`),
        x: finiteNumber(item.x, `Vision OCR page ${pageNum} item ${itemIndex}.x`),
        y: finiteNumber(item.y, `Vision OCR page ${pageNum} item ${itemIndex}.y`),
        width: finiteNumber(item.width, `Vision OCR page ${pageNum} item ${itemIndex}.width`),
        height: finiteNumber(item.height, `Vision OCR page ${pageNum} item ${itemIndex}.height`),
        confidence: finiteNumber(
          item.confidence,
          `Vision OCR page ${pageNum} item ${itemIndex}.confidence`,
        ),
      };
    });
    return {
      pageNum,
      width,
      height,
      text: stringValue(page.text, `Vision OCR page ${pageNum}.text`),
      textItems,
    };
  });
}

/** @param {Record<string, unknown>} request */
async function executeHelper(request) {
  const payload = Buffer.from(JSON.stringify(request));
  return new Promise((resolve, reject) => {
    const child = spawn(HELPER_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });
    /** @type {Buffer[]} */
    const stdout = [];
    /** @type {Buffer[]} */
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    /** @param {Error | VisionOcrError} error */
    const fail = (error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error instanceof VisionOcrError ? error : new VisionOcrError(error.message, error));
    };

    child.on("error", (error) =>
      fail(new VisionOcrError("Unable to launch Vision OCR helper.", error)),
    );
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > HELPER_OUTPUT_MAX_BYTES) {
        fail(new VisionOcrError("Vision OCR helper response exceeded its byte limit."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= HELPER_STDERR_MAX_BYTES) return;
      const remaining = HELPER_STDERR_MAX_BYTES - stderrBytes;
      const bounded = chunk.subarray(0, remaining);
      stderr.push(bounded);
      stderrBytes += bounded.byteLength;
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(
          new VisionOcrError(
            stderrText ||
              `Vision OCR helper exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        reject(new VisionOcrError("Vision OCR helper returned invalid JSON.", error));
      }
    });
    child.stdin.on("error", (error) =>
      fail(new VisionOcrError("Vision OCR request write failed.", error)),
    );
    child.stdin.end(payload);
  });
}

/**
 * OCRs pages without native text using LiteParse rendering and Apple Vision.
 * @param {{
 *   parser: { screenshot(inputPath: string, pages: number[]): Promise<Array<{pageNum: number, width: number, height: number, imageBuffer: Buffer}>> },
 *   inputPath: string,
 *   parseResult: { pages: any[], text: string },
 *   stagingDir: string,
 *   ocrLanguage?: string,
 *   numWorkers: number,
 * }} options
 */
export async function applyVisionOcr(options) {
  if (!(await isVisionOcrAvailable())) {
    throw new VisionOcrError("Apple Vision OCR helper is unavailable on this system.");
  }
  const missingPages = options.parseResult.pages.filter(
    (page) => !Array.isArray(page.textItems) || page.textItems.length === 0,
  );
  if (missingPages.length === 0) return options.parseResult;

  const workDir = join(options.stagingDir, "vision-ocr");
  await mkdir(workDir, { recursive: false });
  const pageByNumber = new Map(options.parseResult.pages.map((page) => [page.pageNum, page]));
  const batchSize = Math.min(VISION_BATCH_MAX_PAGES, Math.max(1, options.numWorkers));

  try {
    for (let offset = 0; offset < missingPages.length; offset += batchSize) {
      const batchPages = missingPages.slice(offset, offset + batchSize);
      const pageNumbers = batchPages.map((page) => page.pageNum);
      const screenshots = await options.parser.screenshot(options.inputPath, pageNumbers);
      if (screenshots.length !== pageNumbers.length) {
        throw new VisionOcrError("LiteParse returned an unexpected Vision OCR screenshot count.");
      }
      const images = [];
      for (const screenshot of screenshots) {
        if (!pageNumbers.includes(screenshot.pageNum) || !Buffer.isBuffer(screenshot.imageBuffer)) {
          throw new VisionOcrError("LiteParse returned an invalid Vision OCR screenshot.");
        }
        const path = join(workDir, `page-${screenshot.pageNum}.png`);
        await writeFile(path, screenshot.imageBuffer, { flag: "wx" });
        images.push({ pageNum: screenshot.pageNum, path });
      }
      const rawOutput = await executeHelper({
        images,
        recognitionLanguages: visionRecognitionLanguages(options.ocrLanguage),
        recognitionLevel: "accurate",
        usesLanguageCorrection: true,
        numWorkers: batchSize,
      });
      const visionPages = validateHelperOutput(rawOutput, new Set(pageNumbers));
      for (const visionPage of visionPages) {
        const target = pageByNumber.get(visionPage.pageNum);
        if (!target) throw new VisionOcrError(`Missing parsed page ${visionPage.pageNum}.`);
        const scaleX = target.width / visionPage.width;
        const scaleY = target.height / visionPage.height;
        target.text = visionPage.text;
        target.textItems = visionPage.textItems.map((item) => ({
          ...item,
          x: item.x * scaleX,
          y: item.y * scaleY,
          width: item.width * scaleX,
          height: item.height * scaleY,
        }));
      }
      await Promise.all(images.map((image) => rm(image.path, { force: true })));
    }
    options.parseResult.text = options.parseResult.pages.map((page) => page.text).join("\n\n");
    return options.parseResult;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
