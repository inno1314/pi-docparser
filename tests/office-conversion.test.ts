import assert from "node:assert/strict";
import test from "node:test";

import { needsOfficeConversion } from "../extensions/docparser/office-conversion.mjs";

test("Office conversion recognizes supported presentation and document formats", () => {
  for (const path of ["deck.pptx", "deck.PPTM", "notes.odp", "report.docx", "report.rtf"]) {
    assert.equal(needsOfficeConversion(path), true, path);
  }
  for (const path of ["report.pdf", "scan.png", "sheet.csv", "archive.zip"]) {
    assert.equal(needsOfficeConversion(path), false, path);
  }
});
