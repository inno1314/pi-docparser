import { chmod, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

if (process.platform !== "darwin") {
  console.log("Skipping Apple Vision helper build on non-macOS host.");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "native/vision-ocr.swift");
const binDir = resolve(root, "bin");
const arm64 = resolve(binDir, "vision-ocr-darwin-arm64");
const x64 = resolve(binDir, "vision-ocr-darwin-x64");
const universal = resolve(binDir, "vision-ocr-darwin-universal");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}.`);
}

await mkdir(binDir, { recursive: true });
await Promise.all([arm64, x64, universal].map((path) => rm(path, { force: true })));
try {
  const common = [
    "swiftc",
    "-swift-version",
    "5",
    "-O",
    "-framework",
    "AppKit",
    "-framework",
    "Vision",
    source,
  ];
  run("xcrun", [...common, "-target", "arm64-apple-macos14.0", "-o", arm64]);
  run("xcrun", [...common, "-target", "x86_64-apple-macos14.0", "-o", x64]);
  run("lipo", ["-create", arm64, x64, "-output", universal]);
  await chmod(universal, 0o755);
  run("codesign", ["--force", "--sign", "-", universal]);
} finally {
  await Promise.all([arm64, x64].map((path) => rm(path, { force: true })));
}
