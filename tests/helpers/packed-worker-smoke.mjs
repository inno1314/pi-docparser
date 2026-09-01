#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const consumerRoot = process.cwd();
const packageRoot = join(consumerRoot, "node_modules", "pi-docparser");
const workerPath = join(packageRoot, "extensions", "docparser", "native-worker.mjs");
const protocolPath = join(packageRoot, "extensions", "docparser", "native-protocol.mjs");
assert.match(workerPath, /native-worker\.mjs$/);

const protocol = await import(pathToFileURL(protocolPath).href);
const jobId = "packed-native-worker-smoke";
const stagingDir = join(consumerRoot, ".native-worker-staging");
const outputPath = join(consumerRoot, "parsed.json");
await mkdir(stagingDir);
await writeFile(join(stagingDir, ".native-job-owner"), jobId);

const request = {
  version: protocol.PROTOCOL_VERSION,
  operation: "parse",
  jobId,
  inputPath: join(consumerRoot, "minimal.pdf"),
  stagingDir,
  outputPath,
  config: {
    outputFormat: "json",
    ocrEnabled: false,
    ocrEngine: "auto",
    numWorkers: 1,
    maxPages: 1,
    dpi: 72,
    preserveVerySmallText: false,
    quiet: true,
  },
};
protocol.validateWorkerRequest(request);

const child = spawn(process.execPath, [workerPath], {
  cwd: consumerRoot,
  stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.resume();
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const requestPipe = child.stdio[3];
const responsePipe = child.stdio[4];
assert.ok(requestPipe && typeof requestPipe !== "number" && "end" in requestPipe);
assert.ok(responsePipe && typeof responsePipe !== "number" && Symbol.asyncIterator in responsePipe);

const responsePromise = protocol.readSingleFrame(
  responsePipe,
  protocol.RESPONSE_MAX_BYTES,
  "Packed worker response",
);
requestPipe.end(protocol.encodeFrame(request, protocol.REQUEST_MAX_BYTES, "Packed worker request"));
const closePromise = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});
const [response, close] = await Promise.all([responsePromise, closePromise]);
assert.deepEqual(close, { code: 0, signal: null }, stderr);
protocol.validateWorkerResponse(response, request);
assert.equal(response.ok, true);
assert.equal(response.result.outputPath, outputPath);
assert.equal(response.result.pageCount, 1);

const parsed = JSON.parse(await readFile(outputPath, "utf8"));
assert.equal(parsed.text, "Hello Pi");
assert.equal(parsed.pages.length, 1);
assert.equal((await stat(outputPath)).size, response.result.outputBytes);
await assert.rejects(stat(stagingDir), { code: "ENOENT" });
