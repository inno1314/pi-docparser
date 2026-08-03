import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NativeCancellationError,
  NativeCrashError,
  NativeDisposedError,
  NativeOperationError,
  NativeProtocolError,
  NativeTimeoutError,
  createNativeExecutor,
} from "../extensions/docparser/native-executor.ts";
import type { LiteParseToolConfig, NativeParseJob } from "../extensions/docparser/types.ts";

const workerUrl = new URL("./helpers/fake-native-worker.mjs", import.meta.url);
const config: LiteParseToolConfig = {
  outputFormat: "text",
  ocrEnabled: false,
  numWorkers: 1,
  maxPages: 1,
  dpi: 150,
  preserveVerySmallText: false,
  quiet: true,
};

async function fixture(
  directory: string,
  name: string,
  control: Record<string, unknown>,
): Promise<string> {
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify(control));
  return path;
}

function job(directory: string, inputPath: string, name: string): NativeParseJob {
  return {
    operation: "parse",
    inputPath,
    stagingDir: join(directory, `${name}.staging`),
    outputPath: join(directory, `${name}.txt`),
    config,
  };
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const contents = (await readFile(path, "utf8")).trim();
      if (/^[1-9]\d*$/.test(contents)) {
        const pid = Number(contents);
        if (Number.isSafeInteger(pid)) return pid;
      }
    } catch {
      // The worker has not published the PID yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for a valid PID in ${path}`);
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processIsLive(pid: number): Promise<boolean> {
  if (!processExists(pid)) return false;
  if (process.platform === "win32") return true;

  const state = await new Promise<string | undefined>((resolve) => {
    execFile(
      "ps",
      ["-o", "stat=", "-p", String(pid)],
      { encoding: "utf8", timeout: 1_000 },
      (error, stdout) => resolve(error ? undefined : stdout.trim()),
    );
  });
  if (state?.startsWith("Z")) return false;
  return state ? true : processExists(pid);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while ((await processIsLive(pid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("executor runs one fair FIFO job at a time", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-executor-fifo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, "events.log");
  const inputs = await Promise.all([
    fixture(directory, "one", { id: "one", logPath, delay: 80 }),
    fixture(directory, "two", { id: "two", logPath, delay: 10 }),
    fixture(directory, "three", { id: "three", logPath }),
  ]);
  const executor = createNativeExecutor({ workerUrl, timeoutMs: 2_000 });
  t.after(() => executor.dispose());
  await Promise.all(
    inputs.map((input, index) => executor.execute(job(directory, input, `job-${index}`))),
  );
  assert.deepEqual((await readFile(logPath, "utf8")).trim().split("\n"), [
    "start:one",
    "end:one",
    "start:two",
    "end:two",
    "start:three",
    "end:three",
  ]);
});

test("queued abort removes a job without spawning it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-executor-queued-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, "events.log");
  const firstInput = await fixture(directory, "first", { id: "first", logPath, delay: 120 });
  const secondInput = await fixture(directory, "second", { id: "second", logPath });
  const executor = createNativeExecutor({ workerUrl, timeoutMs: 2_000 });
  t.after(() => executor.dispose());
  const first = executor.execute(job(directory, firstInput, "first"));
  const controller = new AbortController();
  const second = executor.execute(job(directory, secondInput, "second"), {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(second, NativeCancellationError);
  await first;
  assert.equal((await readFile(logPath, "utf8")).includes("second"), false);
});

test("active abort tears down the detached root and grandchild process tree", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-executor-active-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootPidPath = join(directory, "root.pid");
  const grandchildPidPath = join(directory, "grandchild.pid");
  const input = await fixture(directory, "hang", {
    mode: "hang",
    rootPidPath,
    grandchildPidPath,
  });
  const executor = createNativeExecutor({ workerUrl, timeoutMs: 5_000 });
  t.after(() => executor.dispose());
  const controller = new AbortController();
  const pending = executor.execute(job(directory, input, "hang"), { signal: controller.signal });
  const [rootPid, grandchildPid] = await Promise.all([
    waitForPid(rootPidPath),
    waitForPid(grandchildPidPath),
  ]);
  controller.abort();
  await assert.rejects(pending, NativeCancellationError);
  await Promise.all([waitForProcessExit(rootPid), waitForProcessExit(grandchildPid)]);
  assert.equal(await processIsLive(rootPid), false);
  assert.equal(await processIsLive(grandchildPid), false);
});

test(
  "abort poisons and settles by the teardown deadline when an escaped process blocks close",
  { skip: process.platform === "win32", timeout: 8_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "native-executor-uncertain-teardown-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const rootPidPath = join(directory, "root.pid");
    const escapedPidPath = join(directory, "escaped.pid");
    const input = await fixture(directory, "hang", {
      mode: "escaped-pipe-hang",
      rootPidPath,
      grandchildPidPath: escapedPidPath,
    });
    const executor = createNativeExecutor({ workerUrl, timeoutMs: 30_000 });
    const controller = new AbortController();
    const pending = executor.execute(job(directory, input, "hang"), {
      signal: controller.signal,
    });
    const [, escapedPid] = await Promise.all([waitForPid(rootPidPath), waitForPid(escapedPidPath)]);
    t.after(async () => {
      if (await processIsLive(escapedPid)) {
        try {
          process.kill(-escapedPid, "SIGKILL");
        } catch {
          process.kill(escapedPid, "SIGKILL");
        }
        await waitForProcessExit(escapedPid);
      }
      await executor.dispose();
    });

    const started = Date.now();
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof NativeDisposedError);
      assert.match(error.message, /teardown remained uncertain/i);
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4_500, `teardown failed too early after ${elapsed}ms`);
    assert.ok(elapsed < 7_500, `teardown did not settle by its deadline: ${elapsed}ms`);
    await assert.rejects(executor.execute(job(directory, input, "poisoned")), NativeDisposedError);
  },
);

test("timeout starts on activation and removes the root and grandchild process tree", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-executor-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootPidPath = join(directory, "root.pid");
  const grandchildPidPath = join(directory, "grandchild.pid");
  const input = await fixture(directory, "hang", { mode: "hang", rootPidPath, grandchildPidPath });
  const executor = createNativeExecutor({ workerUrl, timeoutMs: 1_000 });
  t.after(() => executor.dispose());
  const pending = executor.execute(job(directory, input, "hang"));
  const timedOut = assert.rejects(pending, NativeTimeoutError);
  const [rootPid, grandchildPid] = await Promise.all([
    waitForPid(rootPidPath),
    waitForPid(grandchildPidPath),
  ]);
  await timedOut;
  await Promise.all([waitForProcessExit(rootPid), waitForProcessExit(grandchildPid)]);
  assert.equal(await processIsLive(rootPid), false);
  assert.equal(await processIsLive(grandchildPid), false);
});

test(
  "abnormal POSIX exit removes surviving process-group descendants and executor stays usable",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "native-executor-abnormal-tree-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const grandchildPidPath = join(directory, "grandchild.pid");
    const crashing = await fixture(directory, "crashing", {
      mode: "abnormal-grandchild",
      grandchildPidPath,
    });
    const normal = await fixture(directory, "normal-after-crash", {});
    const executor = createNativeExecutor({ workerUrl, timeoutMs: 5_000 });
    t.after(() => executor.dispose());

    const failed = executor.execute(job(directory, crashing, "crashing"));
    const grandchildPid = await waitForPid(grandchildPidPath);
    await assert.rejects(failed, NativeCrashError);
    await waitForProcessExit(grandchildPid);
    assert.equal(await processIsLive(grandchildPid), false);

    const result = await executor.execute(job(directory, normal, "normal-after-crash"));
    assert.equal(result.pageCount, 1);
  },
);

test("queued time does not consume a later job's timeout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-executor-timeout-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputs = await Promise.all([
    ...Array.from({ length: 10 }, (_, index) =>
      fixture(directory, `blocker-${index}`, { delay: 300 }),
    ),
    fixture(directory, "last", { delay: 50 }),
  ]);
  const executor = createNativeExecutor({ workerUrl, timeoutMs: 3_000 });
  t.after(() => executor.dispose());
  await Promise.all(
    inputs.map((input, index) => executor.execute(job(directory, input, `queued-${index}`))),
  );
});

test("malformed, oversized, trailing, and mismatched responses are protocol errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-executor-protocol-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executor = createNativeExecutor({ workerUrl, timeoutMs: 2_000 });
  t.after(() => executor.dispose());
  for (const mode of ["malformed", "oversized", "trailing", "wrong-job"]) {
    const input = await fixture(directory, mode, { mode });
    await assert.rejects(executor.execute(job(directory, input, mode)), NativeProtocolError, mode);
  }
});

test("ordinary failures, abnormal exits, disposal, and owned cleanup stay classified", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-executor-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executor = createNativeExecutor({ workerUrl, timeoutMs: 2_000 });
  const ordinary = await fixture(directory, "ordinary", { mode: "ordinary" });
  await assert.rejects(
    executor.execute(job(directory, ordinary, "ordinary")),
    NativeOperationError,
  );
  const abnormal = await fixture(directory, "abnormal", { mode: "abnormal" });
  await assert.rejects(executor.execute(job(directory, abnormal, "abnormal")), NativeCrashError);
  const normal = await fixture(directory, "normal", {});
  const staging = join(directory, "cleanup.staging");
  const callerArtifact = join(directory, "caller-owned.txt");
  await writeFile(callerArtifact, "keep");
  await executor.execute({ ...job(directory, normal, "cleanup"), stagingDir: staging });
  await assert.rejects(stat(staging), /ENOENT/);
  assert.equal(await readFile(callerArtifact, "utf8"), "keep");

  const collision = join(directory, "collision.staging");
  await mkdir(collision);
  await writeFile(join(collision, "caller-owned"), "keep");
  await assert.rejects(
    executor.execute({ ...job(directory, normal, "collision"), stagingDir: collision }),
    NativeOperationError,
  );
  assert.equal(await readFile(join(collision, "caller-owned"), "utf8"), "keep");
  await executor.dispose();
  await assert.rejects(executor.execute(job(directory, normal, "later")), NativeDisposedError);
});

test("disposal aborts active work, rejects queued work, and waits for teardown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-executor-dispose-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootPidPath = join(directory, "root.pid");
  const hanging = await fixture(directory, "hanging", { mode: "hang", rootPidPath });
  const queued = await fixture(directory, "queued", {});
  const executor = createNativeExecutor({ workerUrl, timeoutMs: 5_000 });
  const active = executor.execute(job(directory, hanging, "active"));
  const waiting = executor.execute(job(directory, queued, "queued"));
  const rootPid = await waitForPid(rootPidPath);
  const activeRejected = assert.rejects(active, NativeDisposedError);
  const waitingRejected = assert.rejects(waiting, NativeDisposedError);
  await executor.dispose();
  await activeRejected;
  await waitingRejected;
  assert.equal(await processIsLive(rootPid), false);
});

test("immediate disposal cancels an activated job before spawn and still settles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-executor-immediate-dispose-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootPidPath = join(directory, "root.pid");
  const input = await fixture(directory, "job", { rootPidPath, delay: 500 });
  const executor = createNativeExecutor({ workerUrl, timeoutMs: 5_000 });
  const pending = executor.execute(job(directory, input, "job"));
  const rejected = assert.rejects(pending, NativeDisposedError);
  await executor.dispose();
  await rejected;
  await assert.rejects(readFile(rootPidPath), /ENOENT/);
});

test("oversized requests reject before spawning and passwords are not process arguments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-executor-request-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootPidPath = join(directory, "root.pid");
  const input = await fixture(directory, "request", { rootPidPath });
  const executor = createNativeExecutor({ workerUrl, timeoutMs: 2_000 });
  t.after(() => executor.dispose());
  await assert.rejects(
    executor.execute({
      ...job(directory, input, "oversized-request"),
      config: { ...config, password: "secret".repeat(20_000) },
    }),
    NativeProtocolError,
  );
  await assert.rejects(readFile(rootPidPath), /ENOENT/);

  const secret = `document-password-${Date.now()}-${Math.random()}`;
  const secretInput = await fixture(directory, "secret", { secret });
  await executor.execute({
    ...job(directory, secretInput, "secret"),
    config: { ...config, password: secret },
  });
});
