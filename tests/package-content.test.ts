import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("..", import.meta.url);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

type PackFile = { path: string };
type PackResult = { files: PackFile[] };

async function dryRunPackagePaths(): Promise<string[]> {
  const { stdout } = await execFileAsync(npmCommand, ["pack", "--json", "--dry-run"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const results = JSON.parse(stdout) as PackResult[];
  assert.equal(results.length, 1, "npm pack should describe exactly one package");
  return results[0].files.map(({ path }) => path).sort();
}

test("published package contains worker runtime and legal/skill assets but no tests", async () => {
  const paths = await dryRunPackagePaths();
  const requiredPaths = [
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "extensions/docparser/native-protocol.mjs",
    "extensions/docparser/native-worker.mjs",
    "extensions/docparser/parse-output.mjs",
    "licenses/LiteParse-APACHE-2.0.txt",
    "skills/parse-document/SKILL.md",
  ];

  for (const path of requiredPaths) {
    assert.ok(paths.includes(path), `packed package is missing ${path}`);
  }
  assert.equal(new Set(paths).size, paths.length, "packed paths must be unique");
  assert.equal(
    paths.some((path) => path === "tests" || path.startsWith("tests/")),
    false,
    "packed package must exclude test suites and fixtures",
  );
});

test("the packed worker has a plain-JavaScript project import graph", async () => {
  const source = await readFile(
    new URL("../extensions/docparser/native-worker.mjs", import.meta.url),
    "utf8",
  );
  const relativeImports = [...source.matchAll(/from\s+["'](\.\/[^"']+)["']/g)].map(
    ([, specifier]) => specifier,
  );

  assert.deepEqual(relativeImports.sort(), ["./native-protocol.mjs", "./parse-output.mjs"]);
  assert.equal(
    relativeImports.every((specifier) => specifier.endsWith(".mjs")),
    true,
  );
});
