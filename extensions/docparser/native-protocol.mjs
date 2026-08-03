// @ts-check

import { isAbsolute, relative } from "node:path";

export const PROTOCOL_VERSION = 1;
export const REQUEST_MAX_BYTES = 64 * 1024;
export const RESPONSE_MAX_BYTES = 1024 * 1024;

const OPERATIONS = new Set(["parse", "search", "screenshot"]);

export class ProtocolValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {string[]} required @param {string[]} optional @param {string} label */
function assertKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new ProtocolValidationError(`${label} contains unknown field: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new ProtocolValidationError(`${label} is missing field: ${key}`);
  }
}

/** @param {unknown} value @param {string} label */
function assertString(value, label) {
  if (typeof value !== "string") throw new ProtocolValidationError(`${label} must be a string.`);
  return value;
}

/** @param {unknown} value @param {string} label */
function assertNonemptyString(value, label) {
  const text = assertString(value, label);
  if (!text) throw new ProtocolValidationError(`${label} must not be empty.`);
  return text;
}

/** @param {unknown} value @param {string} label */
function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new ProtocolValidationError(`${label} must be a boolean.`);
  return value;
}

/** @param {unknown} value @param {string} label @param {number} minimum @param {number} maximum */
function assertInteger(value, label, minimum, maximum) {
  if (
    !Number.isInteger(value) ||
    /** @type {number} */ (value) < minimum ||
    /** @type {number} */ (value) > maximum
  ) {
    throw new ProtocolValidationError(
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return /** @type {number} */ (value);
}

/** @param {unknown} value @param {string} label */
function assertFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolValidationError(`${label} must be finite.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function assertAbsolutePath(value, label) {
  const path = assertNonemptyString(value, label);
  if (!isAbsolute(path)) throw new ProtocolValidationError(`${label} must be absolute.`);
  return path;
}

/** @param {string} child @param {string} parent */
function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** @param {unknown} value */
function validateConfig(value) {
  if (!isRecord(value)) throw new ProtocolValidationError("request.config must be an object.");
  const required = [
    "outputFormat",
    "ocrEnabled",
    "numWorkers",
    "maxPages",
    "dpi",
    "preserveVerySmallText",
    "quiet",
  ];
  const optional = ["ocrLanguage", "ocrServerUrl", "targetPages", "password", "tessdataPath"];
  assertKeys(value, required, optional, "request.config");
  if (value.outputFormat !== "text" && value.outputFormat !== "json") {
    throw new ProtocolValidationError("request.config.outputFormat must be text or json.");
  }
  assertBoolean(value.ocrEnabled, "request.config.ocrEnabled");
  assertInteger(value.numWorkers, "request.config.numWorkers", 1, 8);
  assertInteger(value.maxPages, "request.config.maxPages", 1, 1000);
  assertInteger(value.dpi, "request.config.dpi", 72, 300);
  assertBoolean(value.preserveVerySmallText, "request.config.preserveVerySmallText");
  if (value.quiet !== true) throw new ProtocolValidationError("request.config.quiet must be true.");
  for (const key of optional) {
    if (key in value) assertString(value[key], `request.config.${key}`);
  }
  if (
    typeof value.targetPages === "string" &&
    Buffer.byteLength(value.targetPages, "utf8") > 16 * 1024
  ) {
    throw new ProtocolValidationError("request.config.targetPages exceeds its UTF-8 byte limit.");
  }
}

/** Strictly validates and returns a worker request. @param {unknown} value */
export function validateWorkerRequest(value) {
  if (!isRecord(value)) throw new ProtocolValidationError("Request must be an object.");
  if (value.version !== PROTOCOL_VERSION)
    throw new ProtocolValidationError("Unsupported protocol version.");
  const operation = assertNonemptyString(value.operation, "request.operation");
  if (!OPERATIONS.has(operation)) throw new ProtocolValidationError("Unsupported operation.");
  assertNonemptyString(value.jobId, "request.jobId");
  const inputPath = assertAbsolutePath(value.inputPath, "request.inputPath");
  const stagingDir = assertAbsolutePath(value.stagingDir, "request.stagingDir");
  if (inputPath === stagingDir)
    throw new ProtocolValidationError("Staging path must not equal the input path.");

  if (operation === "parse") {
    assertKeys(
      value,
      ["version", "operation", "jobId", "inputPath", "stagingDir", "outputPath", "config"],
      [],
      "parse request",
    );
    const outputPath = assertAbsolutePath(value.outputPath, "request.outputPath");
    if (isInside(outputPath, stagingDir))
      throw new ProtocolValidationError("Published output must be outside staging.");
    validateConfig(value.config);
  } else if (operation === "search") {
    assertKeys(
      value,
      [
        "version",
        "operation",
        "jobId",
        "inputPath",
        "stagingDir",
        "phrase",
        "caseSensitive",
        "maxResults",
        "config",
      ],
      [],
      "search request",
    );
    const phrase = assertNonemptyString(value.phrase, "request.phrase");
    if (!phrase.trim() || Buffer.byteLength(phrase, "utf8") > 4 * 1024) {
      throw new ProtocolValidationError("request.phrase is blank or exceeds its UTF-8 byte limit.");
    }
    assertBoolean(value.caseSensitive, "request.caseSensitive");
    assertInteger(value.maxResults, "request.maxResults", 1, 200);
    validateConfig(value.config);
  } else {
    assertKeys(
      value,
      ["version", "operation", "jobId", "inputPath", "stagingDir", "outputDir", "pages", "dpi"],
      ["password"],
      "screenshot request",
    );
    const outputDir = assertAbsolutePath(value.outputDir, "request.outputDir");
    if (isInside(outputDir, stagingDir))
      throw new ProtocolValidationError("Published screenshot directory must be outside staging.");
    if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 4) {
      throw new ProtocolValidationError("request.pages must contain between one and four pages.");
    }
    const seen = new Set();
    for (const page of value.pages) {
      const parsed = assertInteger(page, "request.pages entry", 1, 2 ** 32 - 1);
      if (seen.has(parsed))
        throw new ProtocolValidationError("request.pages must not contain duplicates.");
      seen.add(parsed);
    }
    assertInteger(value.dpi, "request.dpi", 72, 300);
    if ("password" in value) assertString(value.password, "request.password");
  }

  return value;
}

/** @param {Record<string, unknown>} hit @param {string} label */
function validateHit(hit, label) {
  assertKeys(
    hit,
    ["pageNum", "text", "x", "y", "width", "height"],
    ["fontName", "fontSize", "confidence"],
    label,
  );
  assertInteger(hit.pageNum, `${label}.pageNum`, 1, 2 ** 32 - 1);
  assertString(hit.text, `${label}.text`);
  for (const key of ["x", "y", "width", "height"]) assertFinite(hit[key], `${label}.${key}`);
  if ("fontName" in hit) assertString(hit.fontName, `${label}.fontName`);
  for (const key of ["fontSize", "confidence"])
    if (key in hit) assertFinite(hit[key], `${label}.${key}`);
}

/** Strictly validates a response and matches it to a request. @param {unknown} value @param {Record<string, unknown>} request */
export function validateWorkerResponse(value, request) {
  if (!isRecord(value)) throw new ProtocolValidationError("Response must be an object.");
  assertKeys(
    value,
    ["version", "operation", "jobId", "ok", value.ok === true ? "result" : "error"],
    [],
    "response",
  );
  if (value.version !== PROTOCOL_VERSION)
    throw new ProtocolValidationError("Response protocol version mismatch.");
  if (value.operation !== request.operation)
    throw new ProtocolValidationError("Response operation mismatch.");
  if (value.jobId !== request.jobId) throw new ProtocolValidationError("Response job id mismatch.");
  assertBoolean(value.ok, "response.ok");

  if (value.ok === false) {
    if (!isRecord(value.error))
      throw new ProtocolValidationError("response.error must be an object.");
    assertKeys(value.error, ["kind", "message"], [], "response.error");
    if (value.error.kind !== "ordinary")
      throw new ProtocolValidationError("response.error.kind must be ordinary.");
    assertNonemptyString(value.error.message, "response.error.message");
    return value;
  }

  if (!isRecord(value.result))
    throw new ProtocolValidationError("response.result must be an object.");
  const result = value.result;
  if (request.operation === "parse") {
    assertKeys(result, ["pageCount", "outputBytes", "outputPath"], [], "parse result");
    assertInteger(
      result.pageCount,
      "parse result.pageCount",
      0,
      /** @type {number} */ (/** @type {Record<string, unknown>} */ (request.config).maxPages),
    );
    assertInteger(result.outputBytes, "parse result.outputBytes", 0, 256 * 1024 * 1024);
    if (result.outputPath !== request.outputPath)
      throw new ProtocolValidationError("Parse output path mismatch.");
  } else if (request.operation === "search") {
    assertKeys(
      result,
      ["pageCount", "hits", "truncatedByCount", "truncatedByBytes"],
      [],
      "search result",
    );
    assertInteger(
      result.pageCount,
      "search result.pageCount",
      0,
      /** @type {number} */ (/** @type {Record<string, unknown>} */ (request.config).maxPages),
    );
    if (
      !Array.isArray(result.hits) ||
      result.hits.length > /** @type {number} */ (request.maxResults)
    )
      throw new ProtocolValidationError("search result.hits is invalid.");
    result.hits.forEach((/** @type {unknown} */ hit, /** @type {number} */ index) => {
      if (!isRecord(hit))
        throw new ProtocolValidationError(`search result.hits[${index}] must be an object.`);
      validateHit(hit, `search result.hits[${index}]`);
    });
    assertBoolean(result.truncatedByCount, "search result.truncatedByCount");
    assertBoolean(result.truncatedByBytes, "search result.truncatedByBytes");
  } else {
    assertKeys(result, ["screenshotDir", "screenshots", "totalBytes"], [], "screenshot result");
    if (result.screenshotDir !== request.outputDir)
      throw new ProtocolValidationError("Screenshot output directory mismatch.");
    if (!Array.isArray(result.screenshots) || result.screenshots.length > 4)
      throw new ProtocolValidationError("screenshot result.screenshots is invalid.");
    if (result.screenshots.length !== /** @type {unknown[]} */ (request.pages).length) {
      throw new ProtocolValidationError("Screenshot result count does not match the request.");
    }
    let screenshotBytes = 0;
    const screenshotPages = new Set();
    result.screenshots.forEach((/** @type {unknown} */ item, /** @type {number} */ index) => {
      if (!isRecord(item))
        throw new ProtocolValidationError(
          `screenshot result.screenshots[${index}] must be an object.`,
        );
      assertKeys(
        item,
        ["pageNum", "width", "height", "outputPath", "bytes"],
        [],
        `screenshot result.screenshots[${index}]`,
      );
      assertInteger(item.pageNum, "screenshot pageNum", 1, 2 ** 32 - 1);
      if (
        !(/** @type {number[]} */ (request.pages).includes(/** @type {number} */ (item.pageNum))) ||
        screenshotPages.has(item.pageNum)
      ) {
        throw new ProtocolValidationError("Screenshot result pages do not match the request.");
      }
      screenshotPages.add(item.pageNum);
      assertFinite(item.width, "screenshot width");
      assertFinite(item.height, "screenshot height");
      assertAbsolutePath(item.outputPath, "screenshot outputPath");
      if (
        !isInside(
          /** @type {string} */ (item.outputPath),
          /** @type {string} */ (result.screenshotDir),
        )
      ) {
        throw new ProtocolValidationError(
          "Screenshot output path is outside the published directory.",
        );
      }
      screenshotBytes += assertInteger(item.bytes, "screenshot bytes", 0, 25 * 1024 * 1024);
    });
    assertInteger(result.totalBytes, "screenshot result.totalBytes", 0, 64 * 1024 * 1024);
    if (result.totalBytes !== screenshotBytes)
      throw new ProtocolValidationError("Screenshot byte total mismatch.");
  }
  return value;
}

/** @param {unknown} value @param {number} maximum @param {string} label */
export function encodeFrame(value, maximum, label) {
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new ProtocolValidationError(
      `${label} is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (payload.byteLength > maximum)
    throw new ProtocolValidationError(`${label} exceeds the ${maximum}-byte frame limit.`);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

/** Reads exactly one framed JSON value and rejects trailing bytes. @param {NodeJS.ReadableStream & AsyncIterable<unknown>} stream @param {number} maximum @param {string} label */
export async function readSingleFrame(stream, maximum, label) {
  let header = Buffer.alloc(0);
  let payload = Buffer.alloc(0);
  let declared;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : typeof rawChunk === "string"
        ? Buffer.from(rawChunk)
        : Buffer.from(/** @type {Uint8Array} */ (rawChunk));
    let offset = 0;
    if (header.byteLength < 4) {
      const count = Math.min(4 - header.byteLength, chunk.byteLength);
      header = Buffer.concat([header, chunk.subarray(0, count)]);
      offset += count;
      if (header.byteLength === 4) {
        declared = header.readUInt32BE(0);
        if (declared > maximum)
          throw new ProtocolValidationError(
            `${label} declares ${declared} bytes, above the ${maximum}-byte frame limit.`,
          );
      }
    }
    if (declared !== undefined && offset < chunk.byteLength) {
      const remaining = declared - payload.byteLength;
      const count = Math.min(remaining, chunk.byteLength - offset);
      if (count > 0) payload = Buffer.concat([payload, chunk.subarray(offset, offset + count)]);
      offset += count;
      if (offset < chunk.byteLength)
        throw new ProtocolValidationError(`${label} contains trailing data.`);
    }
  }
  if (header.byteLength !== 4)
    throw new ProtocolValidationError(`${label} ended before its frame header.`);
  if (declared === undefined || payload.byteLength !== declared)
    throw new ProtocolValidationError(`${label} ended before its declared payload.`);
  let value;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch (error) {
    throw new ProtocolValidationError(
      `${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return value;
}

/** @param {NodeJS.WritableStream} stream @param {unknown} value @param {number} maximum @param {string} label */
export async function writeSingleFrame(stream, value, maximum, label) {
  const frame = encodeFrame(value, maximum, label);
  await new Promise((resolve, reject) => {
    const onError = (/** @type {unknown} */ error) => reject(error);
    stream.once("error", onError);
    stream.end(frame, () => {
      stream.removeListener("error", onError);
      resolve(undefined);
    });
  });
  return frame.byteLength - 4;
}
