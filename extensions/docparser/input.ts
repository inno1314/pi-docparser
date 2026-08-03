import { constants as fsConstants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";

import {
  IMAGE_EXTENSIONS,
  MAX_PAGE_NUMBER,
  MAX_PAGE_SELECTION_BYTES,
  MAX_PAGE_SELECTION_EXPANSION,
  MAX_PAGE_SELECTION_TOKENS,
  MAX_SCREENSHOT_PAGES,
  MAX_SEARCH_PHRASE_BYTES,
  OFFICE_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
} from "./constants.ts";
import type { InputCategory, InputInspection, ScreenshotSelection } from "./types.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizeDocumentPathInput(input: string): string {
  return input.trim().replace(/^@/, "").replace(UNICODE_SPACES, " ");
}

function expandHomeDirectory(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return `${homedir()}${filePath.slice(1)}`;
  }

  return filePath;
}

function tryMacOsAmPmVariant(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNfdVariant(filePath: string): string {
  return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replace(/'/g, "\u2019");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingPath(filePath: string, cwd: string): Promise<string> {
  const expanded = expandHomeDirectory(filePath);
  const resolved = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
  const nfdVariant = tryNfdVariant(resolved);

  for (const candidate of new Set([
    resolved,
    tryMacOsAmPmVariant(resolved),
    nfdVariant,
    tryCurlyQuoteVariant(resolved),
    tryCurlyQuoteVariant(nfdVariant),
  ])) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return resolved;
}

async function ensureReadableFile(filePath: string, sourcePath: string): Promise<void> {
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      throw new Error("not a regular file");
    }
    await access(filePath, fsConstants.R_OK);
  } catch {
    throw new Error(`Document file not found, not readable, or not a regular file: ${sourcePath}`);
  }
}

function getInputCategory(extension: string): InputCategory | undefined {
  if (extension === ".pdf") {
    return "pdf";
  }

  if (OFFICE_EXTENSIONS.has(extension)) {
    return "office";
  }

  if (SPREADSHEET_EXTENSIONS.has(extension)) {
    return "spreadsheet";
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  return undefined;
}

async function readFileHeader(filePath: string, length: number): Promise<Buffer> {
  const handle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isPdfHeader(header: Buffer): boolean {
  return header.length >= 4 && header.toString("utf8", 0, 4) === "%PDF";
}

function isPngHeader(header: Buffer): boolean {
  return (
    header.length >= 4 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47
  );
}

function isJpegHeader(header: Buffer): boolean {
  return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
}

async function inspectInputFile(filePath: string): Promise<InputInspection> {
  const extension = extname(filePath).toLowerCase();
  const category = getInputCategory(extension);

  if (category) {
    return { extension, category };
  }

  try {
    const header = await readFileHeader(filePath, 16);

    if (isPdfHeader(header)) {
      return { extension: extension || ".pdf", category: "pdf" };
    }

    if (!extension && isPngHeader(header)) {
      return { extension: ".png", category: "image" };
    }

    if (!extension && isJpegHeader(header)) {
      return { extension: ".jpg", category: "image" };
    }
  } catch {
    // Best-effort inspection only. Readability is validated separately.
  }

  return { extension, category: "other" };
}

export async function resolveDocumentTarget(
  input: string,
  cwd: string,
): Promise<{
  sourcePath: string;
  resolvedPath: string;
  inspection: InputInspection;
}> {
  const sourcePath = normalizeDocumentPathInput(input);
  const resolvedPath = await resolveExistingPath(sourcePath, cwd);

  await ensureReadableFile(resolvedPath, sourcePath);

  return {
    sourcePath,
    resolvedPath,
    inspection: await inspectInputFile(resolvedPath),
  };
}

function parsePageNumber(value: string, token: string): number {
  const normalized = value.replace(/^0+/, "") || "0";
  const maximum = String(MAX_PAGE_NUMBER);

  if (
    normalized === "0" ||
    normalized.length > maximum.length ||
    (normalized.length === maximum.length && normalized > maximum)
  ) {
    throw new Error(`Page number must be between 1 and ${MAX_PAGE_NUMBER}: ${token}`);
  }

  return Number(normalized);
}

export function parsePageSelection(
  selection: string,
  maxPageCount = MAX_PAGE_SELECTION_EXPANSION,
): number[] {
  const byteLength = Buffer.byteLength(selection, "utf8");
  if (byteLength > MAX_PAGE_SELECTION_BYTES) {
    throw new Error(`Page selection exceeds the ${MAX_PAGE_SELECTION_BYTES}-byte UTF-8 limit.`);
  }
  if (
    !Number.isInteger(maxPageCount) ||
    maxPageCount < 1 ||
    maxPageCount > MAX_PAGE_SELECTION_EXPANSION
  ) {
    throw new Error(
      `Page count limit must be an integer between 1 and ${MAX_PAGE_SELECTION_EXPANSION}.`,
    );
  }

  const tokens = selection.split(",");
  if (tokens.length > MAX_PAGE_SELECTION_TOKENS) {
    throw new Error(`Page selection exceeds the ${MAX_PAGE_SELECTION_TOKENS}-token limit.`);
  }

  const pages = new Set<number>();
  let expansionWork = 0;

  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) {
      throw new Error("Page selection contains an empty token.");
    }

    const singleMatch = /^(\d+)$/.exec(token);
    if (singleMatch) {
      expansionWork += 1;
      if (expansionWork > MAX_PAGE_SELECTION_EXPANSION) {
        throw new Error(
          `Page selection exceeds the ${MAX_PAGE_SELECTION_EXPANSION}-page expansion limit.`,
        );
      }
      pages.add(parsePageNumber(singleMatch[1], token));
      continue;
    }

    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (!rangeMatch) {
      throw new Error(`Invalid page selection token: ${token}`);
    }

    const start = parsePageNumber(rangeMatch[1], token);
    const end = parsePageNumber(rangeMatch[2], token);
    if (end < start) {
      throw new Error(`Page range must be ascending: ${token}`);
    }

    const rangeLength = end - start + 1;
    if (rangeLength > MAX_PAGE_SELECTION_EXPANSION - expansionWork) {
      throw new Error(
        `Page selection exceeds the ${MAX_PAGE_SELECTION_EXPANSION}-page expansion limit.`,
      );
    }
    expansionWork += rangeLength;

    for (let page = start; page <= end; page += 1) {
      pages.add(page);
    }
  }

  const result = Array.from(pages).sort((a, b) => a - b);
  if (result.length > maxPageCount) {
    throw new Error(`Page selection contains more than ${maxPageCount} selected pages.`);
  }

  return result;
}

export function validateSearchPhrase(phrase: string): void {
  if (!phrase.trim()) {
    throw new Error("Search phrase must not be blank.");
  }

  if (Buffer.byteLength(phrase, "utf8") > MAX_SEARCH_PHRASE_BYTES) {
    throw new Error(`Search phrase exceeds the ${MAX_SEARCH_PHRASE_BYTES}-byte UTF-8 limit.`);
  }
}

export function resolveScreenshotSelection(selection?: string): ScreenshotSelection {
  if (selection === undefined) {
    return { pageNumbers: [1], description: "page 1" };
  }

  const trimmedSelection = selection.trim();
  if (!trimmedSelection) {
    throw new Error("Screenshot page selection must not be empty.");
  }

  if (["all", "*"].includes(trimmedSelection.toLowerCase())) {
    throw new Error(
      `Screenshot requests must name at most ${MAX_SCREENSHOT_PAGES} explicit pages; make bounded repeated calls instead of using "all" or "*".`,
    );
  }

  const pageNumbers = parsePageSelection(trimmedSelection, MAX_SCREENSHOT_PAGES);
  return {
    pageNumbers,
    description: `pages ${pageNumbers.join(", ")}`,
  };
}
