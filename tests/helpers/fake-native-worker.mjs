#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";

import {
  PROTOCOL_VERSION,
  REQUEST_MAX_BYTES,
  RESPONSE_MAX_BYTES,
  encodeFrame,
  readSingleFrame,
  writeSingleFrame,
} from "../../extensions/docparser/native-protocol.mjs";

async function writePid(path, pid) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, String(pid));
  await rename(temporaryPath, path);
}

const request = await readSingleFrame(
  createReadStream("", { fd: 3, autoClose: false }),
  REQUEST_MAX_BYTES,
  "Request",
);
const responsePipe = createWriteStream("", { fd: 4, autoClose: false });
const control = JSON.parse(await readFile(request.inputPath, "utf8"));
const logId = control.logOperation ? request.operation : (control.id ?? request.jobId);
if (control.logPath) await appendFile(control.logPath, `start:${logId}\n`);
if (control.rootPidPath) await writePid(control.rootPidPath, process.pid);
if (
  control.secret &&
  (JSON.stringify(process.argv).includes(control.secret) ||
    JSON.stringify(process.env).includes(control.secret))
) {
  process.stderr.write("secret leaked through argv or environment\n");
  process.exit(9);
}

if (control.mode === "hang" || control.mode === "escaped-pipe-hang") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: control.mode === "escaped-pipe-hang",
    stdio:
      control.mode === "escaped-pipe-hang" ? ["ignore", "ignore", "ignore", "ignore", 4] : "ignore",
  });
  if (control.grandchildPidPath) await writePid(control.grandchildPidPath, grandchild.pid);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (control.mode === "abnormal-grandchild") {
  const grandchild = spawn(
    process.execPath,
    ["-e", 'process.send?.("ready"); setInterval(() => {}, 1000)'],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  await new Promise((resolve, reject) => {
    grandchild.once("error", reject);
    grandchild.once("message", (message) => {
      if (message === "ready") resolve();
      else reject(new Error("Unexpected grandchild readiness message."));
    });
  });
  if (control.grandchildPidPath) await writePid(control.grandchildPidPath, grandchild.pid);
  grandchild.disconnect();
}
if (control.delay) await new Promise((resolve) => setTimeout(resolve, control.delay));
if (control.mode === "abnormal" || control.mode === "abnormal-grandchild") {
  process.stderr.write("fake worker crash\n");
  process.exit(7);
}

let result;
if (request.operation === "parse") {
  const output = control.output ?? "fake parsed output";
  await writeFile(request.outputPath, output);
  result = {
    pageCount: 1,
    outputBytes: Buffer.byteLength(output),
    outputPath: request.outputPath,
  };
} else if (request.operation === "search") {
  result = { pageCount: 1, hits: [], truncatedByCount: false, truncatedByBytes: false };
} else {
  await mkdir(request.outputDir);
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const screenshots = [];
  for (const pageNum of request.pages) {
    const outputPath = `${request.outputDir}/page_${pageNum}.png`;
    await writeFile(outputPath, image);
    screenshots.push({ pageNum, width: 1, height: 1, outputPath, bytes: image.byteLength });
  }
  result = {
    screenshotDir: request.outputDir,
    screenshots,
    totalBytes: screenshots.length * image.byteLength,
  };
}
const response = {
  version: PROTOCOL_VERSION,
  operation: request.operation,
  jobId: control.mode === "wrong-job" ? "wrong" : request.jobId,
  ok: true,
  result,
};

if (control.mode === "malformed") {
  responsePipe.end(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("{")]));
} else if (control.mode === "oversized") {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(RESPONSE_MAX_BYTES + 1);
  responsePipe.end(header);
} else if (control.mode === "trailing") {
  responsePipe.end(
    Buffer.concat([encodeFrame(response, RESPONSE_MAX_BYTES, "Response"), Buffer.from([1])]),
  );
} else if (control.mode === "ordinary") {
  await writeSingleFrame(
    responsePipe,
    {
      version: PROTOCOL_VERSION,
      operation: request.operation,
      jobId: request.jobId,
      ok: false,
      error: { kind: "ordinary", message: "fake parse failure" },
    },
    RESPONSE_MAX_BYTES,
    "Response",
  );
} else {
  await writeSingleFrame(responsePipe, response, RESPONSE_MAX_BYTES, "Response");
}
if (control.logPath) await appendFile(control.logPath, `end:${logId}\n`);
