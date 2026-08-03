import { availableParallelism } from "node:os";

export const PREVIEW_MAX_LINES = 20;
export const PREVIEW_MAX_BYTES = 2 * 1024;

export const DEFAULT_MAX_PAGES = 100;
export const MAX_PAGES = 1000;

export const DEFAULT_DPI = 150;
export const MIN_DPI = 72;
export const MAX_DPI = 300;

export const DEFAULT_NUM_WORKERS = Math.min(4, Math.max(1, availableParallelism() - 1));
export const MAX_NUM_WORKERS = 8;

export const DEFAULT_MAX_RESULTS = 50;
export const MAX_RESULTS = 200;
export const MAX_SEARCH_PHRASE_BYTES = 4 * 1024;

export const MAX_PAGE_SELECTION_BYTES = 16 * 1024;
export const MAX_PAGE_SELECTION_TOKENS = 1000;
export const MAX_PAGE_SELECTION_EXPANSION = 1000;
export const MAX_PAGE_NUMBER = 2 ** 32 - 1;
export const MAX_SCREENSHOT_PAGES = 4;

export const WORKER_TIMEOUT_MS = 10 * 60 * 1000;
export const IPC_REQUEST_MAX_BYTES = 64 * 1024;
export const IPC_RESPONSE_MAX_BYTES = 1024 * 1024;
export const STDERR_TAIL_MAX_BYTES = 64 * 1024;

export const PARSED_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
export const SCREENSHOT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const SCREENSHOT_JOB_MAX_BYTES = 64 * 1024 * 1024;
export const INLINE_PNG_MAX_BYTES = 3 * 1024 * 1024;
export const INLINE_PNG_TOTAL_MAX_BYTES = 12 * 1024 * 1024;

export const INSTALL_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

export const OFFICE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".docm",
  ".odt",
  ".rtf",
  ".pages",
  ".ppt",
  ".pptx",
  ".pptm",
  ".odp",
  ".key",
]);

export const SPREADSHEET_EXTENSIONS = new Set([
  ".xls",
  ".xlsx",
  ".xlsm",
  ".ods",
  ".csv",
  ".tsv",
  ".numbers",
]);

export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
  ".webp",
  ".svg",
]);

export const DOCTOR_COMMAND_NAME = "docparser:doctor";
export const DOCTOR_COMMAND = `/${DOCTOR_COMMAND_NAME}`;
