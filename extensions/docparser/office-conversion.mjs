// @ts-check

import { spawn } from "node:child_process";
import { access, mkdir, readdir, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OFFICE_EXTENSIONS = new Set([
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
const CONVERSION_TIMEOUT_MS = 120_000;
const STDERR_MAX_BYTES = 64 * 1024;

export class OfficeConversionError extends Error {
  /** @param {string} message @param {unknown} [cause] */
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OfficeConversionError";
  }
}

/** @param {string} inputPath */
export function needsOfficeConversion(inputPath) {
  return OFFICE_EXTENSIONS.has(extname(inputPath).toLowerCase());
}

/** @param {string} filePath */
async function isReadableFile(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} inputPath @param {string} outputDir */
async function expectedPdf(inputPath, outputDir) {
  const directPath = join(outputDir, `${basename(inputPath, extname(inputPath))}.pdf`);
  if (await isReadableFile(directPath)) return directPath;
  const entries = await readdir(outputDir, { withFileTypes: true });
  const pdfs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => join(outputDir, entry.name));
  if (pdfs.length === 1) return pdfs[0];
  throw new OfficeConversionError("LibreOffice did not produce a PDF output.");
}

/** @param {string} command @param {string[]} args */
function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    /** @type {Buffer[]} */
    const stderr = [];
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new OfficeConversionError("LibreOffice conversion timed out after 120 seconds."));
    }, CONVERSION_TIMEOUT_MS);
    timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new OfficeConversionError("Unable to start LibreOffice conversion.", error));
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= STDERR_MAX_BYTES) return;
      const bounded = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes);
      stderr.push(bounded);
      stderrBytes += bounded.byteLength;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(undefined);
        return;
      }
      const output = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new OfficeConversionError(
          output || `LibreOffice exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
        ),
      );
    });
  });
}

/**
 * Converts an Office document to PDF in a worker-owned temporary profile and output directory.
 * @param {string} inputPath
 * @param {string} stagingDir
 */
export async function convertOfficeToPdf(inputPath, stagingDir) {
  if (!needsOfficeConversion(inputPath)) return inputPath;
  const root = resolve(stagingDir, "office-conversion");
  const outputDir = join(root, "output");
  const profileDir = join(root, "profile");
  await mkdir(root, { recursive: false });
  await mkdir(outputDir, { recursive: false });
  await mkdir(profileDir, { recursive: false });
  const profileUrl = pathToFileURL(profileDir).href;
  const command = process.platform === "win32" ? "soffice.exe" : "soffice";

  try {
    await execute(command, [
      "--headless",
      `-env:UserInstallation=${profileUrl}`,
      "--convert-to",
      "pdf",
      "--outdir",
      outputDir,
      inputPath,
    ]);
    const pdfPath = await expectedPdf(inputPath, outputDir);
    if (relative(root, pdfPath).startsWith("..")) {
      throw new OfficeConversionError("LibreOffice returned a PDF outside the job directory.");
    }
    return pdfPath;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
