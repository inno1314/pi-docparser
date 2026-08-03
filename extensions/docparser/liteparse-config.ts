import {
  DEFAULT_DPI,
  DEFAULT_MAX_PAGES,
  DEFAULT_NUM_WORKERS,
  MAX_DPI,
  MAX_NUM_WORKERS,
  MAX_PAGES,
  MIN_DPI,
} from "./constants.ts";
import { parsePageSelection, resolveScreenshotSelection } from "./input.ts";
import type { DocumentParseParams, DocumentParsePlan, LiteParseToolConfig } from "./types.ts";

export const REMOVED_V1_OPTIONS = [
  "preciseBoundingBox",
  "preserveLayoutAlignmentAcrossPages",
] as const;

export function getRemovedV1OptionsMessage(optionNames: string[]): string {
  const options = optionNames.map((name) => `\`${name}\``).join(", ");
  return [
    `Unsupported LiteParse v1 option${optionNames.length === 1 ? "" : "s"}: ${options}.`,
    "This package now uses LiteParse v2, which no longer exposes those options.",
    "Alternative routes for agents: use JSON output for text item bounding boxes, use document_search to locate phrases with bounding boxes, use document_screenshot for visual layout checks, or narrow work with targetPages.",
  ].join(" ");
}

export function getProvidedRemovedV1Options(rawParams: unknown): string[] {
  if (!rawParams || typeof rawParams !== "object") {
    return [];
  }

  return REMOVED_V1_OPTIONS.filter((optionName) => optionName in rawParams);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validateIntegerRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

export function resolveOcrLanguage(
  params: Pick<DocumentParseParams, "ocrLanguage" | "ocrLanguages">,
  ocrServerUrl: string | undefined,
  warnings: string[],
): LiteParseToolConfig["ocrLanguage"] | undefined {
  const singleOcrLanguage = normalizeOptionalString(params.ocrLanguage);
  const ocrLanguages = (params.ocrLanguages ?? [])
    .map((language) => language.trim())
    .filter(Boolean);

  if (singleOcrLanguage && ocrLanguages.length > 0) {
    warnings.push("Both ocrLanguage and ocrLanguages were provided. Using ocrLanguages.");
  }

  if (ocrLanguages.length === 0) {
    return singleOcrLanguage;
  }

  if (ocrServerUrl) {
    if (ocrLanguages.length > 1) {
      warnings.push(
        "Multiple OCR languages were provided, but HTTP OCR servers currently receive only the first language code.",
      );
    }

    return ocrLanguages[0];
  }

  return ocrLanguages.join("+");
}

export function buildLiteParseConfig(
  params: Pick<
    DocumentParseParams,
    | "format"
    | "ocr"
    | "ocrLanguage"
    | "ocrLanguages"
    | "ocrServerUrl"
    | "numWorkers"
    | "maxPages"
    | "targetPages"
    | "dpi"
    | "preserveSmallText"
    | "password"
    | "tessdataPath"
  >,
  warnings: string[],
): LiteParseToolConfig {
  const ocrServerUrl = normalizeOptionalString(params.ocrServerUrl);
  const ocrLanguage = resolveOcrLanguage(params, ocrServerUrl, warnings);
  const numWorkers = params.numWorkers ?? DEFAULT_NUM_WORKERS;
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
  const dpi = params.dpi ?? DEFAULT_DPI;

  validateIntegerRange("numWorkers", numWorkers, 1, MAX_NUM_WORKERS);
  validateIntegerRange("maxPages", maxPages, 1, MAX_PAGES);
  validateIntegerRange("dpi", dpi, MIN_DPI, MAX_DPI);

  const normalizedTargetPages =
    params.targetPages === undefined
      ? undefined
      : parsePageSelection(params.targetPages, maxPages).join(",");

  return {
    outputFormat: params.format ?? "text",
    ocrEnabled: (params.ocr ?? "auto") !== "off",
    ocrLanguage,
    ocrServerUrl,
    numWorkers,
    maxPages,
    targetPages: normalizedTargetPages,
    dpi,
    preserveVerySmallText: params.preserveSmallText ?? false,
    password: normalizeOptionalString(params.password),
    tessdataPath: normalizeOptionalString(params.tessdataPath),
    quiet: true,
  };
}

export function buildDocumentParsePlan(params: DocumentParseParams): DocumentParsePlan {
  const warnings: string[] = [];
  const parserConfig = buildLiteParseConfig(params, warnings);

  return {
    parserConfig,
    screenshotSelection:
      params.screenshotPages !== undefined
        ? resolveScreenshotSelection(params.screenshotPages)
        : undefined,
    warnings,
  };
}
