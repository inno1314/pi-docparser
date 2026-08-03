import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/minimal.pdf", import.meta.url));
const smokeHelperPath = fileURLToPath(
  new URL("./helpers/packed-worker-smoke.mjs", import.meta.url),
);

type PackResult = { filename: string };

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
    env: { ...process.env, npm_config_update_notifier: "false" },
    shell: process.platform === "win32" && command === npmCommand,
  });
}

test(
  "packed install runs the real plain-JavaScript native worker from node_modules",
  { timeout: 240_000 },
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-docparser-packed-install-"));
    try {
      const tarballDirectory = join(temporaryRoot, "tarball");
      const consumerDirectory = join(temporaryRoot, "consumer");
      await Promise.all([mkdir(tarballDirectory), mkdir(consumerDirectory)]);
      await writeFile(
        join(consumerDirectory, "package.json"),
        JSON.stringify({ name: "packed-smoke-consumer", private: true, type: "module" }),
      );

      const { stdout } = await execFileAsync(
        npmCommand,
        ["pack", "--json", "--pack-destination", tarballDirectory, repositoryRoot],
        {
          cwd: temporaryRoot,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60_000,
          shell: process.platform === "win32",
        },
      );
      const packResults = JSON.parse(stdout) as PackResult[];
      assert.equal(packResults.length, 1);
      const tarballPath = join(tarballDirectory, packResults[0].filename);
      assert.ok((await stat(tarballPath)).isFile());

      await run(
        npmCommand,
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          "--legacy-peer-deps",
          tarballPath,
        ],
        consumerDirectory,
      );

      const installedWorker = join(
        consumerDirectory,
        "node_modules",
        "pi-docparser",
        "extensions",
        "docparser",
        "native-worker.mjs",
      );
      assert.ok((await stat(installedWorker)).isFile());
      assert.doesNotMatch(await readFile(installedWorker, "utf8"), /from\s+["'][^"']+\.ts["']/);

      await Promise.all([
        copyFile(fixturePath, join(consumerDirectory, "minimal.pdf")),
        copyFile(smokeHelperPath, join(consumerDirectory, "packed-worker-smoke.mjs")),
      ]);
      await run(process.execPath, ["packed-worker-smoke.mjs"], consumerDirectory);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);
