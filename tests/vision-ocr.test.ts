import assert from "node:assert/strict";
import test from "node:test";

import {
  isVisionOcrAvailable,
  visionRecognitionLanguages,
} from "../extensions/docparser/vision-ocr.mjs";

test("Vision OCR language mapping accepts Tesseract codes and native BCP-47 identifiers", () => {
  assert.deepEqual(visionRecognitionLanguages(undefined), []);
  assert.deepEqual(visionRecognitionLanguages("eng+rus+jpn"), ["en-US", "ru-RU", "ja-JP"]);
  assert.deepEqual(visionRecognitionLanguages("de-DE,fr-FR"), ["de-DE", "fr-FR"]);
});

test("Vision OCR availability is platform-safe", async () => {
  const available = await isVisionOcrAvailable();
  assert.equal(typeof available, "boolean");
  if (process.platform !== "darwin") assert.equal(available, false);
});
