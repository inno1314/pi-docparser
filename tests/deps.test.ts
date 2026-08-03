import assert from "node:assert/strict";
import test from "node:test";

import { DOCTOR_COMMAND } from "../extensions/docparser/constants.ts";
import {
  appendDoctorHint,
  buildInstallStrategies,
  diagnoseDependencies,
  getMissingHostDependencyMessage,
  getPreferredStrategies,
  getRelevantDependencyNames,
  isDependencySetupMessage,
} from "../extensions/docparser/deps.ts";
import type {
  DependencyDiagnosis,
  InputCategory,
  InputInspection,
  InstallStrategy,
  PackageManagerId,
} from "../extensions/docparser/types.ts";

function inspection(category: InputCategory): InputInspection {
  const extensions: Record<InputCategory, string> = {
    pdf: ".pdf",
    office: ".docx",
    spreadsheet: ".xlsx",
    image: ".png",
    other: ".bin",
  };

  return { category, extension: extensions[category] };
}

const missingLibreOffice: DependencyDiagnosis = {
  name: "libreoffice",
  label: "LibreOffice",
  installed: false,
  relevant: true,
  summary: "Office conversion",
  missingMessage: "LibreOffice is not installed",
};

function strategy(id: PackageManagerId): InstallStrategy {
  return {
    id,
    label: id,
    autoRunnable: true,
    commands: [],
  };
}

test("only Office and spreadsheet inputs require a host dependency", () => {
  assert.deepEqual([...getRelevantDependencyNames()], ["libreoffice"]);
  assert.deepEqual([...getRelevantDependencyNames(inspection("office"))], ["libreoffice"]);
  assert.deepEqual([...getRelevantDependencyNames(inspection("spreadsheet"))], ["libreoffice"]);

  for (const category of ["image", "pdf", "other"] as const) {
    assert.deepEqual([...getRelevantDependencyNames(inspection(category))], [], category);
  }
});

test("dependency diagnostics expose LibreOffice guidance only", async () => {
  const [officeDiagnoses, imageDiagnoses] = await Promise.all([
    diagnoseDependencies(inspection("office")),
    diagnoseDependencies(inspection("image")),
  ]);

  assert.equal(officeDiagnoses.length, 1);
  assert.equal(officeDiagnoses[0].name, "libreoffice");
  assert.equal(officeDiagnoses[0].label, "LibreOffice");
  assert.equal(officeDiagnoses[0].relevant, true);
  assert.match(officeDiagnoses[0].missingMessage, /LibreOffice is not installed/);
  assert.match(officeDiagnoses[0].missingMessage, /brew install --cask libreoffice/);
  assert.match(officeDiagnoses[0].missingMessage, /apt-get install libreoffice/);
  assert.match(officeDiagnoses[0].missingMessage, /choco install libreoffice-fresh/);

  assert.equal(imageDiagnoses.length, 1);
  assert.equal(imageDiagnoses[0].name, "libreoffice");
  assert.equal(imageDiagnoses[0].relevant, false);
});

test("image and PDF inputs bypass host dependency preflight", async () => {
  assert.equal(await getMissingHostDependencyMessage(inspection("image")), undefined);
  assert.equal(await getMissingHostDependencyMessage(inspection("pdf")), undefined);
});

test("setup-error recognition and doctor hints apply only to LibreOffice", () => {
  assert.equal(isDependencySetupMessage("LibreOffice is not installed"), true);
  assert.equal(isDependencySetupMessage("ImageMagick is not installed"), false);
  assert.match(appendDoctorHint("LibreOffice is not installed"), new RegExp(DOCTOR_COMMAND));
});

test("install strategies contain only the platform LibreOffice package", async () => {
  assert.deepEqual(await buildInstallStrategies([{ ...missingLibreOffice, installed: true }]), []);

  const strategies = await buildInstallStrategies([missingLibreOffice]);
  if (strategies.length === 0) {
    assert.equal(process.platform, "linux");
    return;
  }

  const expectedPackages: Record<PackageManagerId, string> = {
    brew: "libreoffice",
    "apt-get": "libreoffice",
    dnf: "libreoffice",
    yum: "libreoffice",
    pacman: "libreoffice-fresh",
    zypper: "libreoffice",
    apk: "libreoffice",
    winget: "TheDocumentFoundation.LibreOffice",
    choco: "libreoffice-fresh",
  };

  for (const installStrategy of strategies) {
    const commandLines = installStrategy.commands.map((command) => command.display);
    assert.ok(
      commandLines.some((command) => command.includes(expectedPackages[installStrategy.id])),
      `${installStrategy.id} should install ${expectedPackages[installStrategy.id]}`,
    );
  }
});

test("preferred install strategies retain platform-specific ordering", () => {
  const ids: PackageManagerId[] = [
    "choco",
    "apk",
    "winget",
    "zypper",
    "pacman",
    "yum",
    "dnf",
    "apt-get",
    "brew",
  ];
  const preferredIds = getPreferredStrategies(ids.map(strategy)).map(({ id }) => id);

  if (process.platform === "darwin") {
    assert.equal(preferredIds[0], "brew");
  } else if (process.platform === "linux") {
    assert.deepEqual(preferredIds.slice(0, 6), [
      "apt-get",
      "dnf",
      "yum",
      "pacman",
      "zypper",
      "apk",
    ]);
  } else if (process.platform === "win32") {
    assert.deepEqual(preferredIds.slice(0, 2), ["winget", "choco"]);
  }
});
