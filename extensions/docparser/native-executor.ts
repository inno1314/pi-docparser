import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROTOCOL_VERSION,
  REQUEST_MAX_BYTES,
  RESPONSE_MAX_BYTES,
  encodeFrame,
  readSingleFrame,
  validateWorkerRequest,
  validateWorkerResponse,
} from "./native-protocol.mjs";
import { STDERR_TAIL_MAX_BYTES, WORKER_TIMEOUT_MS } from "./constants.ts";
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
} from "./types.ts";

export type NativeErrorCode =
  | "cancelled"
  | "timeout"
  | "crash"
  | "protocol"
  | "ordinary"
  | "disposed";

export class NativeExecutionError extends Error {
  readonly code: NativeErrorCode;

  constructor(code: NativeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "NativeExecutionError";
  }
}

export class NativeCancellationError extends NativeExecutionError {
  constructor(message = "Native document operation was cancelled.") {
    super("cancelled", message);
    this.name = "NativeCancellationError";
  }
}

export class NativeTimeoutError extends NativeExecutionError {
  constructor(timeoutMs: number) {
    super("timeout", `Native document operation timed out after ${timeoutMs}ms.`);
    this.name = "NativeTimeoutError";
  }
}

export class NativeCrashError extends NativeExecutionError {
  constructor(message: string) {
    super("crash", message);
    this.name = "NativeCrashError";
  }
}

export class NativeProtocolError extends NativeExecutionError {
  constructor(message: string, options?: ErrorOptions) {
    super("protocol", message, options);
    this.name = "NativeProtocolError";
  }
}

export class NativeOperationError extends NativeExecutionError {
  constructor(message: string) {
    super("ordinary", message);
    this.name = "NativeOperationError";
  }
}

export class NativeDisposedError extends NativeExecutionError {
  constructor(message = "Native document executor is disposed.") {
    super("disposed", message);
    this.name = "NativeDisposedError";
  }
}

export interface CreateNativeExecutorOptions {
  workerUrl?: URL | string;
  timeoutMs?: number;
}

type JobResult = NativeParseResult | NativeSearchResult | NativeScreenshotResult;

type QueueEntry = {
  job: NativeJob;
  signal?: AbortSignal;
  resolve: (value: JobResult) => void;
  reject: (error: unknown) => void;
  queuedAbort?: () => void;
  cancelActive?: (error: NativeExecutionError) => void;
  activeCancellation?: NativeExecutionError;
  ownsStaging?: boolean;
};

const TERMINATION_GRACE_MS = 2_000;
const TEARDOWN_LIMIT_MS = 5_000;
const POLL_MS = 40;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stderrSuffix(stderr: Buffer): string {
  const text = stderr.toString("utf8").trim();
  return text ? ` Worker stderr: ${text}` : "";
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.byteLength >= STDERR_TAIL_MAX_BYTES)
    return chunk.subarray(chunk.byteLength - STDERR_TAIL_MAX_BYTES);
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= STDERR_TAIL_MAX_BYTES
    ? combined
    : combined.subarray(combined.byteLength - STDERR_TAIL_MAX_BYTES);
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

async function waitUntil(predicate: () => boolean, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return predicate();
}

async function terminatePosixTree(
  child: ChildProcess,
  closeState: { closed: boolean },
): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return closeState.closed;
  const started = Date.now();
  const graceDeadline = started + TERMINATION_GRACE_MS;
  const finalDeadline = started + TEARDOWN_LIMIT_MS;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ESRCH"
    ) {
      // Probe below determines whether teardown is uncertain.
    }
  }

  await waitUntil(() => !isProcessGroupAlive(pid), graceDeadline);
  if (isProcessGroupAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ESRCH"
      ) {
        // Probe below determines whether teardown is uncertain.
      }
    }
  }

  return waitUntil(() => closeState.closed && !isProcessGroupAlive(pid), finalDeadline);
}

async function terminateWindowsTree(
  child: ChildProcess,
  closeState: { closed: boolean },
): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return closeState.closed;
  let taskkillClosed = true;
  if (!closeState.closed && child.exitCode === null && child.signalCode === null) {
    taskkillClosed = false;
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("close", () => {
      taskkillClosed = true;
    });
    killer.once("error", () => {
      taskkillClosed = true;
    });
  }
  const deadline = Date.now() + TEARDOWN_LIMIT_MS;
  return waitUntil(() => closeState.closed && taskkillClosed, deadline);
}

function sanitizedExecArgv(): string[] {
  // The worker is plain ESM and needs none of the parent's test loaders, inspectors,
  // eval flags, or type-stripping options.
  return [];
}

function nativeWorkerExecutable(): string {
  // LiteParse, LibreOffice, and the worker's fd-based protocol are validated under Node.
  // Oh My Pi may host extensions in Bun, so never use Bun's executable to launch this Node worker.
  return process.release?.name === "node"
    ? process.execPath
    : process.env.PI_DOCPARSER_NODE_PATH?.trim() || "node";
}

class NativeExecutorImpl implements NativeExecutor {
  private readonly workerUrl: URL | string;
  private readonly timeoutMs: number;
  private readonly queue: QueueEntry[] = [];
  private active?: QueueEntry;
  private disposed = false;
  private poisoned = false;
  private disposePromise?: Promise<void>;
  private settleActive?: () => void;

  constructor(options: CreateNativeExecutorOptions = {}) {
    this.workerUrl = options.workerUrl ?? new URL("./native-worker.mjs", import.meta.url);
    this.timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("Native worker timeout must be a positive integer.");
    }
  }

  execute(job: NativeParseJob, options?: NativeExecuteOptions): Promise<NativeParseResult>;
  execute(job: NativeSearchJob, options?: NativeExecuteOptions): Promise<NativeSearchResult>;
  execute(
    job: NativeScreenshotJob,
    options?: NativeExecuteOptions,
  ): Promise<NativeScreenshotResult>;
  execute(job: NativeJob, options: NativeExecuteOptions = {}): Promise<JobResult> {
    if (this.disposed)
      return Promise.reject(
        new NativeDisposedError(
          this.poisoned ? "Native document executor is poisoned and disposed." : undefined,
        ),
      );
    if (options.signal?.aborted) return Promise.reject(new NativeCancellationError());

    return new Promise<JobResult>((resolve, reject) => {
      const entry: QueueEntry = { job, signal: options.signal, resolve, reject };
      if (entry.signal) {
        entry.queuedAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          entry.signal?.removeEventListener("abort", entry.queuedAbort!);
          reject(new NativeCancellationError());
        };
        entry.signal.addEventListener("abort", entry.queuedAbort, { once: true });
      }
      this.queue.push(entry);
      this.pump();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      if (entry.queuedAbort) entry.signal?.removeEventListener("abort", entry.queuedAbort);
      entry.reject(new NativeDisposedError());
    }
    this.disposePromise = (async () => {
      if (!this.active) return;
      const settled = new Promise<void>((resolve) => {
        this.settleActive = resolve;
      });
      const cancellation = new NativeDisposedError(
        "Native document operation was stopped because the executor was disposed.",
      );
      if (this.active.cancelActive) this.active.cancelActive(cancellation);
      else this.active.activeCancellation = cancellation;
      await settled;
    })();
    return this.disposePromise;
  }

  private poison(): void {
    this.poisoned = true;
    this.disposed = true;
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      if (entry.queuedAbort) entry.signal?.removeEventListener("abort", entry.queuedAbort);
      entry.reject(
        new NativeDisposedError(
          "Native document executor was poisoned by uncertain process teardown.",
        ),
      );
    }
  }

  private pump(): void {
    if (this.active || this.disposed) return;
    const entry = this.queue.shift();
    if (!entry) return;
    if (entry.queuedAbort) entry.signal?.removeEventListener("abort", entry.queuedAbort);
    this.active = entry;
    void this.runEntry(entry);
  }

  private async runEntry(entry: QueueEntry): Promise<void> {
    let result: JobResult | undefined;
    let failure: unknown;
    try {
      result = await this.runChild(entry);
    } catch (error) {
      failure = error;
    }

    if (!this.poisoned && entry.ownsStaging) {
      await rm(entry.job.stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (failure === undefined) entry.resolve(result!);
    else entry.reject(failure);

    this.active = undefined;
    this.settleActive?.();
    this.settleActive = undefined;
    this.pump();
  }

  private async runChild(entry: QueueEntry): Promise<JobResult> {
    const timeoutDeadline = Date.now() + this.timeoutMs;
    if (entry.signal?.aborted) throw new NativeCancellationError();
    const requestWithOptionals = {
      version: PROTOCOL_VERSION,
      jobId: randomUUID(),
      ...entry.job,
    } as Record<string, unknown>;
    const wireRequest = JSON.parse(JSON.stringify(requestWithOptionals)) as Record<string, unknown>;
    try {
      validateWorkerRequest(wireRequest);
    } catch (error) {
      throw new NativeProtocolError(
        `Invalid native worker request: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    let requestFrame: Buffer;
    try {
      requestFrame = encodeFrame(wireRequest, REQUEST_MAX_BYTES, "Request");
    } catch (error) {
      throw new NativeProtocolError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }

    if (entry.signal?.aborted) throw new NativeCancellationError();
    if (Date.now() >= timeoutDeadline) throw new NativeTimeoutError(this.timeoutMs);
    try {
      await mkdir(entry.job.stagingDir, { recursive: false });
      entry.ownsStaging = true;
      await writeFile(join(entry.job.stagingDir, ".native-job-owner"), String(wireRequest.jobId), {
        flag: "wx",
      });
    } catch (error) {
      if (entry.activeCancellation) throw entry.activeCancellation;
      throw new NativeOperationError(
        `Could not create the native job staging directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (entry.activeCancellation) throw entry.activeCancellation;
    if (entry.signal?.aborted) throw new NativeCancellationError();
    if (Date.now() >= timeoutDeadline) throw new NativeTimeoutError(this.timeoutMs);
    const workerPath =
      this.workerUrl instanceof URL ? fileURLToPath(this.workerUrl) : this.workerUrl;
    const closeState = { closed: false };
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let exited = false;
    let stderr: Buffer = Buffer.alloc(0);
    let terminalError: NativeExecutionError | undefined;
    let teardownPromise: Promise<boolean> | undefined;
    let responseError: unknown;

    const child = spawn(nativeWorkerExecutable(), [...sanitizedExecArgv(), workerPath], {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let resolveTeardownCompletion!: (value: boolean) => void;
    const teardownCompletion = new Promise<boolean>((resolve) => {
      resolveTeardownCompletion = resolve;
    });
    const trigger = (error: NativeExecutionError, terminate: boolean): void => {
      if (terminalError) return;
      if (
        closeState.closed &&
        (error.code === "cancelled" || error.code === "timeout" || error.code === "disposed")
      )
        return;
      terminalError = error;
      if (terminate) {
        teardownPromise =
          process.platform === "win32"
            ? terminateWindowsTree(child, closeState)
            : terminatePosixTree(child, closeState);
        void teardownPromise.then(resolveTeardownCompletion, () =>
          resolveTeardownCompletion(false),
        );
      }
    };
    const exitPromise = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        exited = true;
        closeCode = code;
        closeSignal = signal;
        if (code !== 0 || signal) {
          trigger(
            new NativeCrashError(
              `Native worker crashed${signal ? ` from signal ${signal}` : ` with exit code ${code}`}.`,
            ),
            true,
          );
        }
        resolve();
      });
    });
    const closePromise = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        closeState.closed = true;
        closeCode = code;
        closeSignal = signal;
        resolve();
      });
    });

    child.once("error", (error) => {
      trigger(new NativeCrashError(`Failed to launch native worker: ${error.message}`), false);
    });
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer | Uint8Array) => {
      stderr = appendTail(stderr, Buffer.from(chunk));
    });

    const responsePipe = child.stdio[4];
    const requestPipe = child.stdio[3];
    if (
      !responsePipe ||
      typeof responsePipe === "number" ||
      !(Symbol.asyncIterator in responsePipe)
    ) {
      trigger(new NativeProtocolError("Native worker response pipe is unavailable."), true);
    }
    const responsePromise =
      responsePipe && typeof responsePipe !== "number" && Symbol.asyncIterator in responsePipe
        ? readSingleFrame(responsePipe, RESPONSE_MAX_BYTES, "Response")
            .then((value) => {
              try {
                return validateWorkerResponse(value, wireRequest) as Record<string, unknown>;
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new NativeProtocolError(`Invalid native worker response: ${message}`, {
                  cause: error,
                });
              }
            })
            .catch(async (error: unknown) => {
              responseError = error;
              const message = error instanceof Error ? error.message : String(error);
              if (message.includes("ended before") && !exited) {
                await Promise.race([exitPromise, delay(20)]);
              }
              if (
                error instanceof NativeProtocolError ||
                !message.includes("ended before") ||
                !exited
              ) {
                trigger(
                  error instanceof NativeProtocolError
                    ? error
                    : new NativeProtocolError(`Invalid native worker response: ${message}`, {
                        cause: error,
                      }),
                  true,
                );
              }
              return undefined;
            })
        : Promise.resolve(undefined);

    if (!requestPipe || typeof requestPipe === "number" || !("end" in requestPipe)) {
      trigger(new NativeProtocolError("Native worker request pipe is unavailable."), true);
    } else {
      requestPipe.end(requestFrame, (error?: Error | null) => {
        if (error)
          trigger(
            new NativeProtocolError(`Failed to send native worker request: ${error.message}`, {
              cause: error,
            }),
            true,
          );
      });
    }

    const timeout = setTimeout(
      () => {
        trigger(new NativeTimeoutError(this.timeoutMs), true);
      },
      Math.max(1, timeoutDeadline - Date.now()),
    );
    const onAbort = () => trigger(new NativeCancellationError(), true);
    entry.cancelActive = (error) => trigger(error, true);
    if (entry.activeCancellation) trigger(entry.activeCancellation, true);
    entry.signal?.addEventListener("abort", onAbort, { once: true });
    if (entry.signal?.aborted) onAbort();

    const completed = Promise.all([closePromise, responsePromise]).then(([, response]) => ({
      kind: "completed" as const,
      response,
    }));
    let response: Record<string, unknown> | undefined;
    try {
      const first = await Promise.race([
        completed,
        teardownCompletion.then((certain) => ({ kind: "teardown" as const, certain })),
      ]);
      if (first.kind === "teardown") {
        if (!first.certain) {
          this.poison();
          throw new NativeDisposedError(
            `${terminalError?.message ?? "Native worker failed."} Process-tree teardown remained uncertain after ${TEARDOWN_LIMIT_MS}ms; the executor was poisoned.`,
          );
        }
        response = (await completed).response;
      } else {
        response = first.response;
        if (teardownPromise && !(await teardownPromise)) {
          this.poison();
          throw new NativeDisposedError(
            `${terminalError?.message ?? "Native worker failed."} Process-tree teardown remained uncertain after ${TEARDOWN_LIMIT_MS}ms; the executor was poisoned.`,
          );
        }
      }
    } finally {
      clearTimeout(timeout);
      entry.signal?.removeEventListener("abort", onAbort);
      entry.cancelActive = undefined;
    }

    if (terminalError) {
      if (terminalError.code === "crash") {
        throw new NativeCrashError(`${terminalError.message}${stderrSuffix(stderr)}`);
      }
      throw terminalError;
    }

    if (response === undefined) {
      if (closeCode !== 0 || closeSignal) {
        throw new NativeCrashError(
          `Native worker crashed${closeSignal ? ` from signal ${closeSignal}` : ` with exit code ${closeCode}`}.${stderrSuffix(stderr)}`,
        );
      }
      const message =
        responseError instanceof Error
          ? responseError.message
          : String(responseError ?? "missing response");
      throw new NativeProtocolError(`Invalid native worker response: ${message}`);
    }

    const validated = response;
    if (closeCode !== 0 || closeSignal) {
      throw new NativeCrashError(
        `Native worker crashed${closeSignal ? ` from signal ${closeSignal}` : ` with exit code ${closeCode}`}.${stderrSuffix(stderr)}`,
      );
    }
    if (validated.ok === false) {
      const workerError = validated.error as { message: string };
      throw new NativeOperationError(workerError.message);
    }
    return validated.result as JobResult;
  }
}

export function createNativeExecutor(options: CreateNativeExecutorOptions = {}): NativeExecutor {
  return new NativeExecutorImpl(options);
}

export function formatNativeExecutionError(error: unknown, fallback: string): string {
  if (!(error instanceof NativeExecutionError)) {
    const message = error instanceof Error ? error.message : String(error);
    return message || fallback;
  }
  if (error.code === "cancelled") return `Document operation was cancelled. ${error.message}`;
  if (error.code === "timeout") return `Document operation timed out. ${error.message}`;
  if (error.code === "crash") return `Native document worker crashed. ${error.message}`;
  if (error.code === "protocol") return `Native document worker protocol error. ${error.message}`;
  return error.message || fallback;
}
