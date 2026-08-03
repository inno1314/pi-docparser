import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  NativeCancellationError,
  NativeCrashError,
  NativeTimeoutError,
  createNativeExecutor,
} from "../extensions/docparser/native-executor.ts";
import { registerDocumentSearchTool } from "../extensions/docparser/search-tool.ts";
import { registerDocumentScreenshotTool } from "../extensions/docparser/screenshot-tool.ts";
import { registerDocumentParseTool } from "../extensions/docparser/tool.ts";
import type {
  NativeExecuteOptions,
  NativeExecutor,
  NativeJob,
  NativeParseJob,
  NativeParseResult,
  NativeScreenshotJob,
  NativeScreenshotResult,
  NativeSearchJob,
  NativeSearchResult,
} from "../extensions/docparser/types.ts";

type RegisteredTool = {
  name: string;
  executionMode?: string;
  execute: (...args: any[]) => Promise<any>;
};

class FakeExecutor implements NativeExecutor {
  calls: Array<{ job: NativeJob; options?: NativeExecuteOptions }> = [];
  failure?: Error;
  screenshotFailure?: Error;
  searchResult?: NativeSearchResult;
  screenshotFiles: Buffer[] = [Buffer.from("png")];
  waitForAbort = false;

  execute(job: NativeParseJob, options?: NativeExecuteOptions): Promise<NativeParseResult>;
  execute(job: NativeSearchJob, options?: NativeExecuteOptions): Promise<NativeSearchResult>;
  execute(
    job: NativeScreenshotJob,
    options?: NativeExecuteOptions,
  ): Promise<NativeScreenshotResult>;
  async execute(
    job: NativeJob,
    options?: NativeExecuteOptions,
  ): Promise<NativeParseResult | NativeSearchResult | NativeScreenshotResult> {
    this.calls.push({ job, options });
    if (this.waitForAbort) {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new NativeCancellationError();
    }
    if (this.failure) throw this.failure;
    if (job.operation === "parse") {
      await writeFile(job.outputPath, `${"preview line\n".repeat(30)}${"x".repeat(3_000)}`);
      return {
        pageCount: 2,
        outputBytes: (await readFile(job.outputPath)).byteLength,
        outputPath: job.outputPath,
      };
    }
    if (job.operation === "search") {
      return (
        this.searchResult ?? {
          pageCount: 1,
          hits: [],
          truncatedByCount: false,
          truncatedByBytes: false,
        }
      );
    }
    if (this.screenshotFailure) throw this.screenshotFailure;
    await mkdir(job.outputDir, { recursive: true });
    const screenshots = [];
    let totalBytes = 0;
    for (let index = 0; index < job.pages.length; index += 1) {
      const data = this.screenshotFiles[index] ?? Buffer.from("png");
      const outputPath = join(job.outputDir, `page_${job.pages[index]}.png`);
      await writeFile(outputPath, data);
      totalBytes += data.byteLength;
      screenshots.push({
        pageNum: job.pages[index],
        width: 100,
        height: 100,
        outputPath,
        bytes: data.byteLength,
      });
    }
    return { screenshotDir: job.outputDir, screenshots, totalBytes };
  }

  async dispose(): Promise<void> {}
}

function captureTools(executor: NativeExecutor): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  registerDocumentParseTool(pi, executor);
  registerDocumentSearchTool(pi, executor);
  registerDocumentScreenshotTool(pi, executor);
  return tools;
}

function execute(tool: RegisteredTool, params: Record<string, unknown>, signal?: AbortSignal) {
  return tool.execute("call", params, signal, undefined, { cwd: process.cwd() });
}

async function waitForCalls(fake: FakeExecutor, count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (fake.calls.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fake.calls.length, count);
}

test("all tools use one injected executor, pass signals, and leave executionMode unset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-shared-executor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  const tools = captureTools(fake);
  const signal = new AbortController().signal;
  await execute(tools.get("document_parse")!, { path: input }, signal);
  await execute(tools.get("document_search")!, { path: input, phrase: "hello" }, signal);
  await execute(tools.get("document_screenshot")!, { path: input }, signal);
  assert.deepEqual(
    fake.calls.map((call) => call.job.operation),
    ["parse", "search", "screenshot"],
  );
  assert.ok(fake.calls.every((call) => call.options?.signal === signal));
  assert.ok([...tools.values()].every((tool) => !("executionMode" in tool)));
});

test("concurrent cross-kind tool calls share the native executor's single FIFO", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-concurrent-executor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  const logPath = join(directory, "events.log");
  await writeFile(input, JSON.stringify({ logPath, logOperation: true, delay: 80 }));
  const executor = createNativeExecutor({
    workerUrl: new URL("./helpers/fake-native-worker.mjs", import.meta.url),
    timeoutMs: 5_000,
  });
  t.after(() => executor.dispose());
  const tools = captureTools(executor);

  const [parsed, searched, screenshots] = await Promise.all([
    execute(tools.get("document_parse")!, { path: input }),
    execute(tools.get("document_search")!, { path: input, phrase: "hello" }),
    execute(tools.get("document_screenshot")!, { path: input }),
  ]);
  t.after(() => rm(parsed.details.outputDir, { recursive: true, force: true }));
  t.after(() => rm(screenshots.details.outputDir, { recursive: true, force: true }));
  assert.equal(searched.details.hits.length, 0);
  const events = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.deepEqual(
    events
      .filter((_, index) => index % 2 === 0)
      .map((event) => event.slice("start:".length))
      .sort(),
    ["parse", "screenshot", "search"],
  );
  for (let index = 0; index < events.length; index += 2) {
    assert.equal(events[index].replace("start:", ""), events[index + 1].replace("end:", ""));
  }
});

test("parse reads a bounded preview and isolates optional screenshot failure as a warning", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-parse-warning-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  fake.screenshotFailure = new NativeCrashError("segmentation fault");
  const result = await execute(captureTools(fake).get("document_parse")!, {
    path: input,
    screenshotPages: "1",
  });
  assert.equal(fake.calls.length, 2);
  assert.notEqual(fake.calls[0].job.stagingDir, fake.calls[1].job.stagingDir);
  assert.match(result.content[0].text, /Preview truncated/);
  assert.match(result.content[0].text, /worker crashed/i);
  assert.equal(result.details.pageCount, 2);
  assert.equal(result.details.screenshotCount, 0);
  assert.equal(
    (await readFile(result.details.outputPath, "utf8")).startsWith("preview line"),
    true,
  );
});

test("search exposes bounded projected hits and explicit worker truncation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-search-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  fake.searchResult = {
    pageCount: 1,
    hits: Array.from({ length: 200 }, (_, index) => ({
      pageNum: 1,
      text: `hit ${index} ${"x".repeat(30)}`,
      x: index,
      y: 0,
      width: 1,
      height: 1,
    })),
    truncatedByCount: true,
    truncatedByBytes: true,
  };
  const result = await execute(captureTools(fake).get("document_search")!, {
    path: input,
    phrase: "hit",
    maxResults: 200,
  });
  assert.equal(result.details.hits.length, 200);
  assert.equal(result.details.truncatedByCount, true);
  assert.equal(result.details.truncatedByBytes, true);
  assert.equal(result.details.previewTruncated, true);
  assert.match(result.content[0].text, /result limit/);
  assert.match(result.content[0].text, /response byte limit/);
  assert.ok(Buffer.byteLength(result.content[0].text) < 4_096);
});

test("screenshots inline only small PNGs and retain paths plus warnings for omitted files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-screenshot-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  fake.screenshotFiles = [Buffer.from("small"), Buffer.alloc(3 * 1024 * 1024 + 1)];
  const result = await execute(captureTools(fake).get("document_screenshot")!, {
    path: input,
    pages: "1,2",
  });
  assert.equal(result.content.filter((item: { type: string }) => item.type === "image").length, 1);
  assert.equal(result.details.screenshots.length, 2);
  assert.equal(result.details.warnings.length, 1);
  assert.match(result.content[0].text, /was not inlined/);
  assert.match(result.content[0].text, /page_2\.png/);
});

test("active cancellation stays classified and removes the failed parse temp directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-active-cancellation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  fake.waitForAbort = true;
  const controller = new AbortController();
  const pending = execute(
    captureTools(fake).get("document_parse")!,
    { path: input },
    controller.signal,
  );
  await waitForCalls(fake, 1);
  const outputDir = dirname((fake.calls[0].job as NativeParseJob).outputPath);
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
  await assert.rejects(stat(outputDir), /ENOENT/);
});

test("failed screenshot execution removes its tool-owned temp directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-failed-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  fake.screenshotFailure = new NativeCrashError("fake crash");
  await assert.rejects(
    execute(captureTools(fake).get("document_screenshot")!, { path: input }),
    /worker crashed/i,
  );
  const screenshotJob = fake.calls[0].job as NativeScreenshotJob;
  await assert.rejects(stat(dirname(screenshotJob.outputDir)), /ENOENT/);
});

test("pre-start cancellation is stable and native timeout/crash categories remain distinct", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-error-categories-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await execute(
    captureTools(new FakeExecutor()).get("document_parse")!,
    { path: input },
    controller.signal,
  );
  assert.match(cancelled.content[0].text, /cancelled before it started/);

  const timeout = new FakeExecutor();
  timeout.failure = new NativeTimeoutError(10);
  await assert.rejects(
    execute(captureTools(timeout).get("document_search")!, { path: input, phrase: "x" }),
    /timed out/i,
  );
  const crash = new FakeExecutor();
  crash.failure = new NativeCrashError("signal SIGSEGV");
  await assert.rejects(
    execute(captureTools(crash).get("document_screenshot")!, { path: input }),
    /worker crashed/i,
  );
});
