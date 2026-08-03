import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  MAX_PAGE_NUMBER,
  MAX_PAGE_SELECTION_BYTES,
  MAX_PAGE_SELECTION_EXPANSION,
  MAX_PAGE_SELECTION_TOKENS,
  MAX_SCREENSHOT_PAGES,
  MAX_SEARCH_PHRASE_BYTES,
} from "../extensions/docparser/constants.ts";
import {
  parsePageSelection,
  resolveDocumentTarget,
  resolveScreenshotSelection,
  validateSearchPhrase,
} from "../extensions/docparser/input.ts";

const execFileAsync = promisify(execFile);

test("page selections are deduplicated, sorted, and normalized by value", () => {
  assert.deepEqual(parsePageSelection("10, 2-4,3,0001,10"), [1, 2, 3, 4, 10]);
  assert.deepEqual(parsePageSelection("1,1,2", 2), [1, 2]);
});

test("page selection accepts exact byte, token, expansion, and page-number boundaries", () => {
  assert.deepEqual(parsePageSelection(`1${" ".repeat(MAX_PAGE_SELECTION_BYTES - 1)}`), [1]);
  assert.deepEqual(
    parsePageSelection(Array.from({ length: MAX_PAGE_SELECTION_TOKENS }, () => "1").join(",")),
    [1],
  );

  const expanded = parsePageSelection(`1-${MAX_PAGE_SELECTION_EXPANSION}`);
  assert.equal(expanded.length, MAX_PAGE_SELECTION_EXPANSION);
  assert.equal(expanded.at(-1), MAX_PAGE_SELECTION_EXPANSION);
  assert.deepEqual(parsePageSelection(String(MAX_PAGE_NUMBER)), [MAX_PAGE_NUMBER]);
});

test("page selection rejects byte, token, expansion, and page-number overflow", () => {
  assert.throws(
    () => parsePageSelection(`1${" ".repeat(MAX_PAGE_SELECTION_BYTES - 1)}é`),
    /byte UTF-8 limit/,
  );
  assert.throws(
    () =>
      parsePageSelection(
        Array.from({ length: MAX_PAGE_SELECTION_TOKENS + 1 }, () => "1").join(","),
      ),
    /token limit/,
  );
  assert.throws(
    () => parsePageSelection(`1-${MAX_PAGE_SELECTION_EXPANSION + 1}`),
    /expansion limit/,
  );
  assert.throws(() => parsePageSelection(`1-500,1-501`), /expansion limit/);
  assert.throws(() => parsePageSelection(String(MAX_PAGE_NUMBER + 1)), /between 1 and/);
  assert.throws(() => parsePageSelection("999999999999999999999999999999"), /between 1 and/);
});

test("page selection rejects malformed complete tokens", () => {
  for (const selection of [
    "",
    " ",
    ",1",
    "1,",
    "1,,2",
    "+1",
    "-1",
    "1-",
    "1.5",
    "1x",
    "1-2x",
    "1-2-3",
    "0",
    "0-1",
    "2-1",
  ]) {
    assert.throws(() => parsePageSelection(selection), selection);
  }
});

test("caller page-count limits apply to deduplicated sparse selections", () => {
  assert.deepEqual(parsePageSelection(`1,${MAX_PAGE_NUMBER}`, 2), [1, MAX_PAGE_NUMBER]);
  assert.deepEqual(parsePageSelection("1,1,2,2", 2), [1, 2]);
  assert.throws(() => parsePageSelection("1,100,1000", 2), /more than 2 selected pages/);
  assert.throws(() => parsePageSelection("1", 0), /Page count limit/);
  assert.throws(
    () => parsePageSelection("1", MAX_PAGE_SELECTION_EXPANSION + 1),
    /Page count limit/,
  );
});

test("search phrases enforce nonblank and exact UTF-8 byte limits", () => {
  assert.doesNotThrow(() => validateSearchPhrase("x".repeat(MAX_SEARCH_PHRASE_BYTES)));
  assert.doesNotThrow(() => validateSearchPhrase("é".repeat(MAX_SEARCH_PHRASE_BYTES / 2)));
  assert.throws(() => validateSearchPhrase(" \n\t "), /must not be blank/);
  assert.throws(
    () => validateSearchPhrase(`${"x".repeat(MAX_SEARCH_PHRASE_BYTES)}é`),
    /byte UTF-8 limit/,
  );
  assert.throws(
    () => validateSearchPhrase("é".repeat(MAX_SEARCH_PHRASE_BYTES / 2 + 1)),
    /byte UTF-8 limit/,
  );
});

test("screenshots default to page 1 and allow at most four explicit pages", () => {
  assert.deepEqual(resolveScreenshotSelection(), {
    pageNumbers: [1],
    description: "page 1",
  });
  assert.deepEqual(resolveScreenshotSelection("4, 1-3,2"), {
    pageNumbers: [1, 2, 3, 4],
    description: "pages 1, 2, 3, 4",
  });
  assert.deepEqual(resolveScreenshotSelection("1,1,2,3,4"), {
    pageNumbers: [1, 2, 3, 4],
    description: "pages 1, 2, 3, 4",
  });
  assert.throws(
    () => resolveScreenshotSelection(`1-${MAX_SCREENSHOT_PAGES + 1}`),
    /more than 4 selected pages/,
  );
});

test("screenshot selections reject blank and unbounded aliases with bounded-call guidance", () => {
  assert.throws(() => resolveScreenshotSelection(" "), /must not be empty/);
  for (const selection of ["all", "ALL", "*"]) {
    assert.throws(
      () => resolveScreenshotSelection(selection),
      /bounded repeated calls instead/,
      selection,
    );
  }
});

test("document targets require regular files and allow symlinks to files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "docparser-input-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const filePath = join(directory, "sample.pdf");
  const symlinkPath = join(directory, "sample-link.pdf");
  const nestedDirectory = join(directory, "folder.pdf");
  await writeFile(filePath, "%PDF-1.4\n", "utf8");
  await symlink(filePath, symlinkPath);
  await mkdir(nestedDirectory);

  const fileTarget = await resolveDocumentTarget(filePath, directory);
  assert.equal(fileTarget.resolvedPath, filePath);
  assert.equal(fileTarget.inspection.category, "pdf");

  const symlinkTarget = await resolveDocumentTarget(symlinkPath, directory);
  assert.equal(symlinkTarget.resolvedPath, symlinkPath);
  assert.equal(symlinkTarget.inspection.category, "pdf");

  await assert.rejects(resolveDocumentTarget(nestedDirectory, directory), /not a regular file/);
  await assert.rejects(
    resolveDocumentTarget(join(directory, "missing.pdf"), directory),
    /not found, not readable, or not a regular file/,
  );
});

test(
  "document targets reject FIFOs, sockets, and devices before opening them",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "docparser-special-file-policy-"));
    t.after(() => rm(directory, { recursive: true, force: true }));

    const fifoPath = join(directory, "input.fifo");
    await execFileAsync("mkfifo", [fifoPath]);
    await assert.rejects(resolveDocumentTarget(fifoPath, directory), /not a regular file/);

    const socketPath = join(directory, "input.socket");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    await assert.rejects(resolveDocumentTarget(socketPath, directory), /not a regular file/);

    await assert.rejects(resolveDocumentTarget("/dev/null", directory), /not a regular file/);
  },
);

test(
  "document targets reject unreadable regular files",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "docparser-unreadable-policy-"));
    const filePath = join(directory, "unreadable.pdf");
    await writeFile(filePath, "%PDF-1.4\n", "utf8");
    await chmod(filePath, 0o000);
    t.after(async () => {
      await chmod(filePath, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    });

    await assert.rejects(resolveDocumentTarget(filePath, directory), /not readable/);
  },
);
