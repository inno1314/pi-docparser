import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import test from "node:test";

import {
  DEFAULT_DPI,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RESULTS,
  DEFAULT_NUM_WORKERS,
  INLINE_PNG_MAX_BYTES,
  INLINE_PNG_TOTAL_MAX_BYTES,
  IPC_REQUEST_MAX_BYTES,
  IPC_RESPONSE_MAX_BYTES,
  MAX_DPI,
  MAX_NUM_WORKERS,
  MAX_PAGES,
  MAX_PAGE_NUMBER,
  MAX_PAGE_SELECTION_BYTES,
  MAX_PAGE_SELECTION_EXPANSION,
  MAX_PAGE_SELECTION_TOKENS,
  MAX_RESULTS,
  MAX_SCREENSHOT_PAGES,
  MAX_SEARCH_PHRASE_BYTES,
  MIN_DPI,
  PARSED_ARTIFACT_MAX_BYTES,
  SCREENSHOT_FILE_MAX_BYTES,
  SCREENSHOT_JOB_MAX_BYTES,
  STDERR_TAIL_MAX_BYTES,
  WORKER_TIMEOUT_MS,
} from "../extensions/docparser/constants.ts";
import {
  buildDocumentParsePlan,
  buildLiteParseConfig,
} from "../extensions/docparser/liteparse-config.ts";
import { DocumentParseSchema } from "../extensions/docparser/schema.ts";
import { DocumentScreenshotSchema } from "../extensions/docparser/screenshot-tool.ts";
import { DocumentSearchSchema } from "../extensions/docparser/search-tool.ts";
import type { LiteParseToolConfig } from "../extensions/docparser/types.ts";

function schemaProperty(
  schema: { properties: Record<string, unknown> },
  propertyName: string,
): Record<string, unknown> {
  const property = schema.properties[propertyName];
  assert.equal(typeof property, "object", `missing schema property ${propertyName}`);
  assert.notEqual(property, null, `missing schema property ${propertyName}`);
  return property as Record<string, unknown>;
}

function assertRange(
  schema: { properties: Record<string, unknown> },
  propertyName: string,
  minimum: number,
  maximum: number,
): void {
  const property = schemaProperty(schema, propertyName);
  assert.equal(property.minimum, minimum, `${propertyName} minimum`);
  assert.equal(property.maximum, maximum, `${propertyName} maximum`);
}

test("resource policy constants match the named defaults and hard limits", () => {
  assert.equal(DEFAULT_MAX_PAGES, 100);
  assert.equal(MAX_PAGES, 1000);
  assert.equal(DEFAULT_NUM_WORKERS, Math.min(4, Math.max(1, availableParallelism() - 1)));
  assert.ok(DEFAULT_NUM_WORKERS >= 1 && DEFAULT_NUM_WORKERS <= 4);
  assert.equal(MAX_NUM_WORKERS, 8);
  assert.equal(DEFAULT_DPI, 150);
  assert.equal(MIN_DPI, 72);
  assert.equal(MAX_DPI, 300);
  assert.equal(DEFAULT_MAX_RESULTS, 50);
  assert.equal(MAX_RESULTS, 200);
  assert.equal(MAX_SEARCH_PHRASE_BYTES, 4 * 1024);
  assert.equal(MAX_PAGE_SELECTION_BYTES, 16 * 1024);
  assert.equal(MAX_PAGE_SELECTION_TOKENS, 1000);
  assert.equal(MAX_PAGE_SELECTION_EXPANSION, 1000);
  assert.equal(MAX_PAGE_NUMBER, 2 ** 32 - 1);
  assert.equal(MAX_SCREENSHOT_PAGES, 4);

  assert.equal(WORKER_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(IPC_REQUEST_MAX_BYTES, 64 * 1024);
  assert.equal(IPC_RESPONSE_MAX_BYTES, 1024 * 1024);
  assert.equal(STDERR_TAIL_MAX_BYTES, 64 * 1024);
  assert.equal(PARSED_ARTIFACT_MAX_BYTES, 256 * 1024 * 1024);
  assert.equal(SCREENSHOT_FILE_MAX_BYTES, 25 * 1024 * 1024);
  assert.equal(SCREENSHOT_JOB_MAX_BYTES, 64 * 1024 * 1024);
  assert.equal(INLINE_PNG_MAX_BYTES, 3 * 1024 * 1024);
  assert.equal(INLINE_PNG_TOTAL_MAX_BYTES, 12 * 1024 * 1024);
});

test("default parser config is project-owned and bounded", () => {
  const config: LiteParseToolConfig = buildLiteParseConfig({}, []);
  assert.deepEqual(config, {
    outputFormat: "text",
    ocrEnabled: true,
    ocrLanguage: undefined,
    ocrServerUrl: undefined,
    numWorkers: DEFAULT_NUM_WORKERS,
    maxPages: DEFAULT_MAX_PAGES,
    targetPages: undefined,
    dpi: DEFAULT_DPI,
    preserveVerySmallText: false,
    password: undefined,
    tessdataPath: undefined,
    quiet: true,
  });

  type MarkdownIsExcluded = "markdown" extends LiteParseToolConfig["outputFormat"] ? false : true;
  const markdownIsExcluded: MarkdownIsExcluded = true;
  assert.equal(markdownIsExcluded, true);
});

test("parser config accepts exact resource boundaries and rejects values beyond them", () => {
  assert.equal(
    buildLiteParseConfig({ numWorkers: MAX_NUM_WORKERS, maxPages: MAX_PAGES, dpi: MAX_DPI }, [])
      .numWorkers,
    MAX_NUM_WORKERS,
  );
  assert.equal(buildLiteParseConfig({ numWorkers: 1, maxPages: 1, dpi: MIN_DPI }, []).dpi, MIN_DPI);

  for (const numWorkers of [0, MAX_NUM_WORKERS + 1, 1.5]) {
    assert.throws(() => buildLiteParseConfig({ numWorkers }, []), /numWorkers/);
  }
  for (const maxPages of [0, MAX_PAGES + 1, 1.5]) {
    assert.throws(() => buildLiteParseConfig({ maxPages }, []), /maxPages/);
  }
  for (const dpi of [MIN_DPI - 1, MAX_DPI + 1, 72.5]) {
    assert.throws(() => buildLiteParseConfig({ dpi }, []), /dpi/);
  }
});

test("target pages normalize against the effective selected-page budget", () => {
  const sparse = buildLiteParseConfig(
    { maxPages: 3, targetPages: `${MAX_PAGE_NUMBER}, 1, 1, 25` },
    [],
  );
  assert.equal(sparse.maxPages, 3);
  assert.equal(sparse.targetPages, `1,25,${MAX_PAGE_NUMBER}`);
});

test("target-page budget and malformed target pages reject instead of clamping", () => {
  assert.throws(
    () => buildLiteParseConfig({ maxPages: 2, targetPages: "1,100,1000" }, []),
    /more than 2 selected pages/,
  );
  assert.throws(() => buildLiteParseConfig({ targetPages: " " }, []), /empty token/);
  assert.throws(() => buildLiteParseConfig({ targetPages: "1x" }, []), /Invalid/);
  assert.throws(() => buildLiteParseConfig({ targetPages: "3-1" }, []), /ascending/);
});

test("parse screenshot planning is optional but bounded when requested", () => {
  assert.equal(buildDocumentParsePlan({ path: "sample.pdf" }).screenshotSelection, undefined);
  assert.deepEqual(
    buildDocumentParsePlan({ path: "sample.pdf", screenshotPages: "4,1-3" }).screenshotSelection,
    {
      pageNumbers: [1, 2, 3, 4],
      description: "pages 1, 2, 3, 4",
    },
  );
  assert.throws(
    () => buildDocumentParsePlan({ path: "sample.pdf", screenshotPages: "all" }),
    /bounded repeated calls/,
  );
  assert.throws(
    () => buildDocumentParsePlan({ path: "sample.pdf", screenshotPages: "1-5" }),
    /more than 4 selected pages/,
  );
});

test("parse, search, and screenshot TypeBox schemas expose every resource maximum", () => {
  assertRange(DocumentParseSchema, "numWorkers", 1, MAX_NUM_WORKERS);
  assertRange(DocumentParseSchema, "maxPages", 1, MAX_PAGES);
  assertRange(DocumentParseSchema, "dpi", MIN_DPI, MAX_DPI);
  assert.equal(
    schemaProperty(DocumentParseSchema, "targetPages").maxLength,
    MAX_PAGE_SELECTION_BYTES,
  );
  assert.equal(
    schemaProperty(DocumentParseSchema, "screenshotPages").maxLength,
    MAX_PAGE_SELECTION_BYTES,
  );

  assertRange(DocumentSearchSchema, "numWorkers", 1, MAX_NUM_WORKERS);
  assertRange(DocumentSearchSchema, "maxPages", 1, MAX_PAGES);
  assertRange(DocumentSearchSchema, "dpi", MIN_DPI, MAX_DPI);
  assertRange(DocumentSearchSchema, "maxResults", 1, MAX_RESULTS);
  assert.equal(schemaProperty(DocumentSearchSchema, "phrase").maxLength, MAX_SEARCH_PHRASE_BYTES);
  assert.equal(
    schemaProperty(DocumentSearchSchema, "targetPages").maxLength,
    MAX_PAGE_SELECTION_BYTES,
  );

  assertRange(DocumentScreenshotSchema, "dpi", MIN_DPI, MAX_DPI);
  assert.equal(
    schemaProperty(DocumentScreenshotSchema, "pages").maxLength,
    MAX_PAGE_SELECTION_BYTES,
  );

  assert.equal("timeoutMs" in DocumentParseSchema.properties, false);
  assert.equal("timeoutMs" in DocumentSearchSchema.properties, false);
  assert.equal("timeoutMs" in DocumentScreenshotSchema.properties, false);
});
