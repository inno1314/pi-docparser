import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { LiteParse } from "@llamaindex/liteparse";

import {
  SCREENSHOT_FILE_MAX_BYTES,
  SCREENSHOT_JOB_MAX_BYTES,
} from "../extensions/docparser/constants.ts";
import {
  NativeOperationError,
  createNativeExecutor,
} from "../extensions/docparser/native-executor.ts";
import type { LiteParseToolConfig } from "../extensions/docparser/types.ts";

const fixture = resolve("tests/fixtures/minimal.pdf");
const config: LiteParseToolConfig = {
  outputFormat: "json",
  ocrEnabled: false,
  ocrEngine: "auto",
  numWorkers: 1,
  maxPages: 1,
  dpi: 72,
  preserveVerySmallText: false,
  quiet: true,
};

async function installFakeLiteParse(t: TestContext, directory: string): Promise<void> {
  const fakeModulePath = join(directory, "fake-liteparse.mjs");
  const loaderPath = join(directory, "loader.mjs");
  const registerPath = join(directory, "register.mjs");
  await writeFile(
    fakeModulePath,
    `import { appendFile, readFile } from "node:fs/promises";
export class LiteParse {
  constructor(config) { this.config = config; }
  async parse(inputPath) {
    const control = JSON.parse(await readFile(inputPath, "utf8"));
    const textItems = control.searchItems ?? [];
    return {
      text: textItems.map((item) => item.text).join(" "),
      pages: [{ pageNum: 1, width: 1, height: 1, text: "", textItems }],
    };
  }
  async screenshot(inputPath, pages) {
    const control = JSON.parse(await readFile(inputPath, "utf8"));
    if (control.invocationLog) await appendFile(control.invocationLog, JSON.stringify(pages) + "\\n");
    const pageNum = pages[0];
    const bytes = control.screenshotSizes[String(pageNum)];
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return [{
      pageNum,
      width: 1,
      height: 1,
      imageBuffer: Buffer.concat([signature, Buffer.alloc(bytes - signature.byteLength)]),
    }];
  }
}
export function searchItems(items) { return items; }
`,
  );
  await writeFile(
    loaderPath,
    `const fakeUrl = new URL("./fake-liteparse.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@llamaindex/liteparse") return { url: fakeUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
`,
  );
  await writeFile(
    registerPath,
    `import { register } from "node:module";
register(new URL("./loader.mjs", import.meta.url), import.meta.url);
`,
  );
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = [previousNodeOptions, `--import=${pathToFileURL(registerPath).href}`]
    .filter(Boolean)
    .join(" ");
  t.after(() => {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  });
}

function textItem(text: string) {
  return { text, x: 0, y: 0, width: 1, height: 1 };
}

test("real worker parses, searches, and screenshots a minimal PDF through bounded artifacts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-worker-integration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executor = createNativeExecutor({ timeoutMs: 30_000 });
  t.after(() => executor.dispose());

  const outputPath = join(directory, "parsed.json");
  const parsed = await executor.execute({
    operation: "parse",
    inputPath: fixture,
    stagingDir: join(directory, ".parse-job"),
    outputPath,
    config,
  });
  assert.equal(parsed.pageCount, 1);
  assert.equal(parsed.outputPath, outputPath);
  assert.equal((await stat(outputPath)).size, parsed.outputBytes);
  const output = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(Object.keys(output), ["pages", "text"]);
  assert.equal(output.text, "Hello Pi");
  assert.deepEqual(Object.keys(output.pages[0]), [
    "pageNum",
    "width",
    "height",
    "text",
    "textItems",
  ]);
  assert.equal("markdown" in output.pages[0], false);

  const searched = await executor.execute({
    operation: "search",
    inputPath: fixture,
    stagingDir: join(directory, ".search-job"),
    phrase: "Hello",
    caseSensitive: false,
    maxResults: 10,
    config,
  });
  assert.equal(searched.hits.length, 1);
  assert.equal(searched.hits[0].pageNum, 1);
  assert.equal(searched.hits[0].text, "Hello");
  assert.equal(searched.truncatedByCount, false);
  assert.equal(searched.truncatedByBytes, false);

  const screenshotDir = join(directory, "screenshots");
  const screenshots = await executor.execute({
    operation: "screenshot",
    inputPath: fixture,
    stagingDir: join(directory, ".screenshot-job"),
    outputDir: screenshotDir,
    pages: [1],
    dpi: 72,
  });
  assert.equal(screenshots.screenshots.length, 1);
  assert.equal(screenshots.screenshots[0].outputPath, join(screenshotDir, "page_1.png"));
  assert.equal((await stat(screenshots.screenshots[0].outputPath)).size, screenshots.totalBytes);
  assert.deepEqual(
    (await readFile(screenshots.screenshots[0].outputPath)).subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
});

test(
  "real worker uses Apple Vision OCR for a rasterized text page",
  { skip: process.platform !== "darwin" ? "Apple Vision is macOS-only" : false },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "native-worker-vision-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const rasterizer = new LiteParse({ dpi: 150, quiet: true });
    const [screenshot] = await rasterizer.screenshot(fixture, [1]);
    const imagePath = join(directory, "hello-pi.png");
    await writeFile(imagePath, screenshot.imageBuffer);

    const executor = createNativeExecutor({ timeoutMs: 30_000 });
    t.after(() => executor.dispose());
    const outputPath = join(directory, "vision.json");
    await executor.execute({
      operation: "parse",
      inputPath: imagePath,
      stagingDir: join(directory, ".vision-job"),
      outputPath,
      config: {
        ...config,
        ocrEnabled: true,
        ocrEngine: "vision",
        dpi: 150,
      },
    });

    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.match(output.text, /Hello\s+Pi/i);
    assert.ok(output.pages[0].textItems.length > 0);
    assert.ok(output.pages[0].textItems.every((item: { confidence?: number }) => item.confidence));
  },
);

test("worker enforces search and screenshot result boundaries with fake LiteParse", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-worker-boundaries-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await installFakeLiteParse(t, directory);
  const executor = createNativeExecutor({ timeoutMs: 30_000 });
  t.after(() => executor.dispose());

  const countInput = join(directory, "search-count.json");
  await writeFile(
    countInput,
    JSON.stringify({ searchItems: [textItem("one"), textItem("two"), textItem("three")] }),
  );
  const countResult = await executor.execute({
    operation: "search",
    inputPath: countInput,
    stagingDir: join(directory, ".search-count"),
    phrase: "hit",
    caseSensitive: false,
    maxResults: 2,
    config,
  });
  assert.equal(countResult.hits.length, 2);
  assert.equal(countResult.truncatedByCount, true);
  assert.equal(countResult.truncatedByBytes, false);

  const bytesInput = join(directory, "search-bytes.json");
  await writeFile(bytesInput, JSON.stringify({ searchItems: [textItem("x".repeat(1024 * 1024))] }));
  const bytesResult = await executor.execute({
    operation: "search",
    inputPath: bytesInput,
    stagingDir: join(directory, ".search-bytes"),
    phrase: "hit",
    caseSensitive: false,
    maxResults: 2,
    config,
  });
  assert.equal(bytesResult.hits.length, 0);
  assert.equal(bytesResult.truncatedByCount, false);
  assert.equal(bytesResult.truncatedByBytes, true);

  const invocationLog = join(directory, "screenshot-invocations.log");
  const screenshotInput = join(directory, "screenshots.json");
  await writeFile(
    screenshotInput,
    JSON.stringify({ invocationLog, screenshotSizes: { 1: 8, 2: 8 } }),
  );
  const screenshotResult = await executor.execute({
    operation: "screenshot",
    inputPath: screenshotInput,
    stagingDir: join(directory, ".screenshots"),
    outputDir: join(directory, "screenshots"),
    pages: [1, 2],
    dpi: 72,
  });
  assert.equal(screenshotResult.screenshots.length, 2);
  assert.deepEqual(
    (await readFile(invocationLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [[1], [2]],
  );

  const oversizedInput = join(directory, "screenshot-oversized.json");
  await writeFile(
    oversizedInput,
    JSON.stringify({ screenshotSizes: { 1: SCREENSHOT_FILE_MAX_BYTES + 1 } }),
  );
  const oversizedStaging = join(directory, ".screenshot-oversized");
  const oversizedOutput = join(directory, "screenshot-oversized");
  await assert.rejects(
    executor.execute({
      operation: "screenshot",
      inputPath: oversizedInput,
      stagingDir: oversizedStaging,
      outputDir: oversizedOutput,
      pages: [1],
      dpi: 72,
    }),
    /file limit/,
  );
  await assert.rejects(stat(oversizedStaging), /ENOENT/);
  await assert.rejects(stat(oversizedOutput), /ENOENT/);

  const aggregateInput = join(directory, "screenshot-aggregate.json");
  const perPageBytes = Math.floor(SCREENSHOT_JOB_MAX_BYTES / 3) + 1;
  await writeFile(
    aggregateInput,
    JSON.stringify({ screenshotSizes: { 1: perPageBytes, 2: perPageBytes, 3: perPageBytes } }),
  );
  const aggregateStaging = join(directory, ".screenshot-aggregate");
  const aggregateOutput = join(directory, "screenshot-aggregate");
  await assert.rejects(
    executor.execute({
      operation: "screenshot",
      inputPath: aggregateInput,
      stagingDir: aggregateStaging,
      outputDir: aggregateOutput,
      pages: [1, 2, 3],
      dpi: 72,
    }),
    /aggregate limit/,
  );
  await assert.rejects(stat(aggregateStaging), /ENOENT/);
  await assert.rejects(stat(aggregateOutput), /ENOENT/);
});

test("failed screenshot cleanup cannot remove an earlier parse artifact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-worker-preservation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executor = createNativeExecutor({ timeoutMs: 30_000 });
  t.after(() => executor.dispose());
  const outputPath = join(directory, "parsed.json");
  await executor.execute({
    operation: "parse",
    inputPath: fixture,
    stagingDir: join(directory, ".parse-job"),
    outputPath,
    config,
  });
  await assert.rejects(
    executor.execute({
      operation: "screenshot",
      inputPath: fixture,
      stagingDir: join(directory, ".failed-screenshot-job"),
      outputDir: join(directory, "failed-screenshots"),
      pages: [2],
      dpi: 72,
    }),
    NativeOperationError,
  );
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).text, "Hello Pi");
  await assert.rejects(stat(join(directory, ".failed-screenshot-job")), /ENOENT/);
  await assert.rejects(stat(join(directory, "failed-screenshots")), /ENOENT/);
});
