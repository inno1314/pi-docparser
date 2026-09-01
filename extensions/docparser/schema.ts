import { StringEnum, Type } from "@earendil-works/pi-ai";

import {
  DEFAULT_DPI,
  DEFAULT_MAX_PAGES,
  DEFAULT_NUM_WORKERS,
  MAX_DPI,
  MAX_NUM_WORKERS,
  MAX_PAGES,
  MAX_PAGE_SELECTION_BYTES,
  MAX_SCREENSHOT_PAGES,
  MIN_DPI,
} from "./constants.ts";

export const DocumentParseSchema = Type.Object({
  path: Type.String({
    description:
      "Path to the document file to parse (PDF, DOCX, PPTX, XLSX, CSV, PNG, JPG, TIFF, WebP, etc.)",
  }),
  format: Type.Optional(
    StringEnum(["text", "json"] as const, {
      description: "Output format for the parsed document (default: text)",
    }),
  ),
  targetPages: Type.Optional(
    Type.String({
      maxLength: MAX_PAGE_SELECTION_BYTES,
      description: 'Optional page selection for parsing, e.g. "1-5,10,15-20"',
    }),
  ),
  screenshotPages: Type.Optional(
    Type.String({
      maxLength: MAX_PAGE_SELECTION_BYTES,
      description: `Optional explicit page selection for screenshots, e.g. "1-3,8" (maximum ${MAX_SCREENSHOT_PAGES} pages). Screenshots are saved as PNG files.`,
    }),
  ),
  ocr: Type.Optional(
    StringEnum(["auto", "off"] as const, {
      description:
        "OCR mode: auto uses native text first and the configured OCR backend only when needed; off disables OCR",
    }),
  ),
  ocrEngine: Type.Optional(
    StringEnum(["auto", "vision", "tesseract"] as const, {
      description:
        "OCR backend: auto uses Apple Vision on supported macOS systems and Tesseract elsewhere; vision requires the bundled macOS helper; tesseract forces LiteParse OCR",
    }),
  ),
  ocrLanguage: Type.Optional(
    Type.String({
      description:
        "Optional single OCR language. Tesseract accepts codes such as eng, deu, fra, and jpn; Apple Vision also accepts BCP-47 identifiers and maps common Tesseract codes.",
    }),
  ),
  ocrLanguages: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description:
        "Optional OCR languages. Apple Vision accepts BCP-47 identifiers and common Tesseract codes; Tesseract joins values into a multilingual language string; HTTP servers receive the first value.",
    }),
  ),
  ocrServerUrl: Type.Optional(
    Type.String({
      description: "Optional HTTP OCR server URL implementing the LiteParse OCR API",
    }),
  ),
  numWorkers: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_NUM_WORKERS,
      description: `Optional OCR worker count (default: ${DEFAULT_NUM_WORKERS}, maximum: ${MAX_NUM_WORKERS})`,
    }),
  ),
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_PAGES,
      description: `Maximum number of pages to parse (default: ${DEFAULT_MAX_PAGES}, maximum: ${MAX_PAGES})`,
    }),
  ),
  dpi: Type.Optional(
    Type.Integer({
      minimum: MIN_DPI,
      maximum: MAX_DPI,
      description: `Rendering DPI for OCR and screenshots (default: ${DEFAULT_DPI})`,
    }),
  ),
  preserveSmallText: Type.Optional(
    Type.Boolean({
      description: "Whether to preserve very small text that would otherwise be filtered out",
    }),
  ),
  password: Type.Optional(
    Type.String({
      description: "Optional password for encrypted or password-protected documents",
    }),
  ),
  tessdataPath: Type.Optional(
    Type.String({
      description:
        "Optional path to a directory containing Tesseract .traineddata files for offline/custom OCR data",
    }),
  ),
});
