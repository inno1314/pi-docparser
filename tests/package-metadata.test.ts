import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface PackageMetadata {
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  engines: Record<string, string>;
}

const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

test("package metadata pins the supported runtime and dependency baseline", () => {
  assert.equal(packageMetadata.version, "4.0.0");
  assert.equal(packageMetadata.dependencies["@llamaindex/liteparse"], "2.10.1");
  assert.equal(packageMetadata.devDependencies["@earendil-works/pi-ai"], "0.83.0");
  assert.equal(packageMetadata.devDependencies["@earendil-works/pi-coding-agent"], "0.83.0");
  assert.equal(packageMetadata.peerDependencies["@earendil-works/pi-ai"], "*");
  assert.equal(packageMetadata.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(packageMetadata.engines.node, ">=22.19.0");
});

test("package metadata preserves user-owned tool dependency versions", () => {
  assert.equal(packageMetadata.devDependencies["@types/node"], "^25.9.5");
  assert.equal(packageMetadata.devDependencies.oxlint, "^1.76.0");
});
