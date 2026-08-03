// @ts-check

import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { finished } from "node:stream/promises";

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const CHUNK_CODE_UNITS = 16 * 1024;

/** @param {unknown} value @param {string} label */
function requiredString(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

/** @param {unknown} value @param {string} label */
function requiredFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be finite.`);
  return value;
}

/** @param {unknown} value */
function optionalString(value) {
  return typeof value === "string" ? value : undefined;
}

/** @param {unknown} value */
function optionalFinite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Project one text item with fixed field order. @param {unknown} value @param {string} label */
export function projectTextItem(value, label = "text item") {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  const item = /** @type {Record<string, unknown>} */ (value);
  /** @type {{text: string, x: number, y: number, width: number, height: number, fontName?: string, fontSize?: number, confidence?: number}} */
  const projected = {
    text: requiredString(item.text, `${label}.text`),
    x: requiredFinite(item.x, `${label}.x`),
    y: requiredFinite(item.y, `${label}.y`),
    width: requiredFinite(item.width, `${label}.width`),
    height: requiredFinite(item.height, `${label}.height`),
  };
  const fontName = optionalString(item.fontName);
  const fontSize = optionalFinite(item.fontSize);
  const confidence = optionalFinite(item.confidence);
  if (fontName !== undefined) projected.fontName = fontName;
  if (fontSize !== undefined) projected.fontSize = fontSize;
  if (confidence !== undefined) projected.confidence = confidence;
  return projected;
}

/** Project one page with fixed field order. @param {unknown} value @param {number} index */
export function projectPage(value, index = 0) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`page ${index} must be an object.`);
  const page = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(page.textItems)) throw new Error(`page ${index}.textItems must be an array.`);
  return {
    pageNum: requiredFinite(page.pageNum, `page ${index}.pageNum`),
    width: requiredFinite(page.width, `page ${index}.width`),
    height: requiredFinite(page.height, `page ${index}.height`),
    text: requiredString(page.text, `page ${index}.text`),
    textItems: page.textItems.map((item, itemIndex) =>
      projectTextItem(item, `page ${index}.textItems[${itemIndex}]`),
    ),
  };
}

/** Project a search hit with page number and the stable item fields. @param {unknown} value @param {number} pageNum @param {string} label */
export function projectSearchHit(value, pageNum, label = "search hit") {
  const item = projectTextItem(value, label);
  return { pageNum: requiredFinite(pageNum, `${label}.pageNum`), ...item };
}

/** @param {string} text */
function* plainChunks(text) {
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(text.length, offset + CHUNK_CODE_UNITS);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    }
    yield text.slice(offset, end);
    offset = end;
  }
}

/** Emits the exact JSON.stringify string representation without materializing it. @param {string} value */
function* jsonStringChunks(value) {
  let output = '"';
  const flush = function* () {
    if (output.length >= CHUNK_CODE_UNITS) {
      yield output;
      output = "";
    }
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) output += '\\"';
    else if (code === 0x5c) output += "\\\\";
    else if (code === 0x08) output += "\\b";
    else if (code === 0x09) output += "\\t";
    else if (code === 0x0a) output += "\\n";
    else if (code === 0x0c) output += "\\f";
    else if (code === 0x0d) output += "\\r";
    else if (code < 0x20) output += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
      } else output += `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (code >= 0xdc00 && code <= 0xdfff)
      output += `\\u${code.toString(16).padStart(4, "0")}`;
    else output += value[index];
    yield* flush();
  }
  output += '"';
  if (output) yield output;
}

class BoundedWriter {
  /** @param {import("node:stream").Writable} stream @param {number} maximum */
  constructor(stream, maximum) {
    this.stream = stream;
    this.maximum = maximum;
    this.bytes = 0;
  }

  /** @param {string} chunk */
  async write(chunk) {
    const bytes = Buffer.byteLength(chunk, "utf8");
    if (this.bytes + bytes > this.maximum)
      throw new Error(`Parsed artifact exceeds the ${this.maximum}-byte limit.`);
    this.bytes += bytes;
    if (!this.stream.write(chunk, "utf8")) {
      await new Promise((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve(undefined);
        };
        const onError = (/** @type {unknown} */ error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          this.stream.off("drain", onDrain);
          this.stream.off("error", onError);
        };
        this.stream.once("drain", onDrain);
        this.stream.once("error", onError);
      });
    }
  }

  /** @param {string} value */
  async writeJsonString(value) {
    for (const chunk of jsonStringChunks(value)) await this.write(chunk);
  }
}

/** Stream a stable compact parse result. @param {unknown} parseResult @param {"text" | "json"} outputFormat @param {import("node:stream").Writable} stream @param {number} [maximum] */
export async function streamParseOutput(
  parseResult,
  outputFormat,
  stream,
  maximum = DEFAULT_MAX_BYTES,
) {
  if (!Number.isInteger(maximum) || maximum < 0)
    throw new Error("Output byte limit must be a non-negative integer.");
  if (typeof parseResult !== "object" || parseResult === null || Array.isArray(parseResult))
    throw new Error("Parse result must be an object.");
  const result = /** @type {Record<string, unknown>} */ (parseResult);
  if (!Array.isArray(result.pages)) throw new Error("Parse result pages must be an array.");
  const text = requiredString(result.text, "Parse result text");
  const writer = new BoundedWriter(stream, maximum);

  if (outputFormat === "text") {
    for (const chunk of plainChunks(text)) await writer.write(chunk);
    return { bytes: writer.bytes, pageCount: result.pages.length };
  }
  if (outputFormat !== "json") throw new Error("Unsupported parse output format.");

  await writer.write('{"pages":[');
  for (let pageIndex = 0; pageIndex < result.pages.length; pageIndex += 1) {
    const rawPage = result.pages[pageIndex];
    if (typeof rawPage !== "object" || rawPage === null || Array.isArray(rawPage))
      throw new Error(`page ${pageIndex} must be an object.`);
    const page = /** @type {Record<string, unknown>} */ (rawPage);
    if (!Array.isArray(page.textItems))
      throw new Error(`page ${pageIndex}.textItems must be an array.`);
    if (pageIndex > 0) await writer.write(",");
    await writer.write('{"pageNum":');
    await writer.write(JSON.stringify(requiredFinite(page.pageNum, `page ${pageIndex}.pageNum`)));
    await writer.write(',"width":');
    await writer.write(JSON.stringify(requiredFinite(page.width, `page ${pageIndex}.width`)));
    await writer.write(',"height":');
    await writer.write(JSON.stringify(requiredFinite(page.height, `page ${pageIndex}.height`)));
    await writer.write(',"text":');
    await writer.writeJsonString(requiredString(page.text, `page ${pageIndex}.text`));
    await writer.write(',"textItems":[');
    for (let itemIndex = 0; itemIndex < page.textItems.length; itemIndex += 1) {
      const item = projectTextItem(
        page.textItems[itemIndex],
        `page ${pageIndex}.textItems[${itemIndex}]`,
      );
      if (itemIndex > 0) await writer.write(",");
      await writer.write('{"text":');
      await writer.writeJsonString(item.text);
      await writer.write(`,"x":${JSON.stringify(item.x)}`);
      await writer.write(`,"y":${JSON.stringify(item.y)}`);
      await writer.write(`,"width":${JSON.stringify(item.width)}`);
      await writer.write(`,"height":${JSON.stringify(item.height)}`);
      if (item.fontName !== undefined) {
        await writer.write(',"fontName":');
        await writer.writeJsonString(item.fontName);
      }
      if (item.fontSize !== undefined)
        await writer.write(`,"fontSize":${JSON.stringify(item.fontSize)}`);
      if (item.confidence !== undefined)
        await writer.write(`,"confidence":${JSON.stringify(item.confidence)}`);
      await writer.write("}");
    }
    await writer.write("]}");
  }
  await writer.write('],"text":');
  await writer.writeJsonString(text);
  await writer.write("}");
  return { bytes: writer.bytes, pageCount: result.pages.length };
}

/** Writes a partial file and atomically publishes it on success. @param {unknown} parseResult @param {"text" | "json"} outputFormat @param {string} partialPath @param {string} outputPath @param {number} [maximum] */
export async function writeParseOutputFile(
  parseResult,
  outputFormat,
  partialPath,
  outputPath,
  maximum = DEFAULT_MAX_BYTES,
) {
  const stream = createWriteStream(partialPath, { flags: "wx" });
  const completion = finished(stream);
  void completion.catch(() => undefined);
  try {
    const metadata = await streamParseOutput(parseResult, outputFormat, stream, maximum);
    stream.end();
    await completion;
    await rename(partialPath, outputPath);
    return metadata;
  } catch (error) {
    stream.destroy();
    await completion.catch(() => undefined);
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
