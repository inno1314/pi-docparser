import type { Static } from "@earendil-works/pi-ai";

import { DocumentParseSchema } from "./schema.ts";

export type DocumentParseParams = Static<typeof DocumentParseSchema>;
export type DocumentOutputFormat = "text" | "json";

export interface NativeSearchHit {
  pageNum: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
  confidence?: number;
}

export interface NativeScreenshotMetadata {
  pageNum: number;
  width: number;
  height: number;
  outputPath: string;
  bytes: number;
}

export interface DocumentParseDetails {
  sourcePath: string;
  resolvedPath: string;
  outputFormat: DocumentOutputFormat;
  outputPath: string;
  outputDir: string;
  pageCount: number;
  screenshotCount: number;
  screenshotDir?: string;
  screenshotPathsPreview?: string[];
  warnings?: string[];
}

export interface DocumentSearchDetails {
  sourcePath: string;
  resolvedPath: string;
  phrase: string;
  caseSensitive: boolean;
  hits: NativeSearchHit[];
  truncatedByCount: boolean;
  truncatedByBytes: boolean;
  previewTruncated: boolean;
  warnings?: string[];
}

export interface DocumentScreenshotDetails {
  sourcePath: string;
  resolvedPath: string;
  outputDir: string;
  screenshotDir: string;
  screenshots: NativeScreenshotMetadata[];
  warnings?: string[];
}

export type InputCategory = "pdf" | "office" | "spreadsheet" | "image" | "other";
export type DependencyName = "libreoffice";
export type PackageManagerId =
  | "brew"
  | "apt-get"
  | "dnf"
  | "yum"
  | "pacman"
  | "zypper"
  | "apk"
  | "winget"
  | "choco";

export interface InputInspection {
  extension: string;
  category: InputCategory;
}

export interface DependencyDiagnosis {
  name: DependencyName;
  label: string;
  installed: boolean;
  detectedCommand?: string;
  relevant: boolean;
  summary: string;
  missingMessage: string;
}

export interface InstallCommandSpec {
  description: string;
  command: string;
  args: string[];
  display: string;
  timeoutMs?: number;
}

export interface InstallStrategy {
  id: PackageManagerId;
  label: string;
  autoRunnable: boolean;
  autoRunBlockedReason?: string;
  commands: InstallCommandSpec[];
}

export interface UnixPrivilegeContext {
  prefix: string[];
  displayPrefix: string;
  autoRunnable: boolean;
  blockedReason?: string;
}

export interface ScreenshotSelection {
  pageNumbers: number[];
  description: string;
}

/** Project-owned parser configuration passed to LiteParse. */
export interface LiteParseToolConfig {
  outputFormat: DocumentOutputFormat;
  ocrEnabled: boolean;
  ocrLanguage?: string;
  ocrServerUrl?: string;
  numWorkers: number;
  maxPages: number;
  targetPages?: string;
  dpi: number;
  preserveVerySmallText: boolean;
  password?: string;
  tessdataPath?: string;
  quiet: true;
}

export interface DocumentParsePlan {
  parserConfig: LiteParseToolConfig;
  screenshotSelection?: ScreenshotSelection;
  warnings: string[];
}

export interface NativeParseJob {
  operation: "parse";
  inputPath: string;
  stagingDir: string;
  outputPath: string;
  config: LiteParseToolConfig;
}

export interface NativeSearchJob {
  operation: "search";
  inputPath: string;
  stagingDir: string;
  phrase: string;
  caseSensitive: boolean;
  maxResults: number;
  config: LiteParseToolConfig;
}

export interface NativeScreenshotJob {
  operation: "screenshot";
  inputPath: string;
  stagingDir: string;
  outputDir: string;
  pages: number[];
  dpi: number;
  password?: string;
}

export type NativeJob = NativeParseJob | NativeSearchJob | NativeScreenshotJob;

export interface NativeParseResult {
  pageCount: number;
  outputBytes: number;
  outputPath: string;
}

export interface NativeSearchResult {
  pageCount: number;
  hits: NativeSearchHit[];
  truncatedByCount: boolean;
  truncatedByBytes: boolean;
}

export interface NativeScreenshotResult {
  screenshotDir: string;
  screenshots: NativeScreenshotMetadata[];
  totalBytes: number;
}

export interface NativeExecuteOptions {
  signal?: AbortSignal;
}

export interface NativeExecutor {
  execute(job: NativeParseJob, options?: NativeExecuteOptions): Promise<NativeParseResult>;
  execute(job: NativeSearchJob, options?: NativeExecuteOptions): Promise<NativeSearchResult>;
  execute(
    job: NativeScreenshotJob,
    options?: NativeExecuteOptions,
  ): Promise<NativeScreenshotResult>;
  dispose(): Promise<void>;
}
