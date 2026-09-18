// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  clonePlaywrightDataDir,
  disablePlaywrightShowfileTransports,
  nightfallDataDirForTestProcess,
  playwrightSeedDataAvailable,
  preparePlaywrightDataDir,
} from "./nightfall-test-data-dir.mjs";
import { defaultNightfallDataDir } from "./worktree-data-dir.mjs";

/** Writes a small file beneath the requested seed directory. */
function writeSeedFile(root, relativeDirectory, filename = "seed.txt") {
  const directory = join(root, relativeDirectory);
  mkdirSync(directory, { recursive: true });
  const contents =
    filename === "showfile.json"
      ? JSON.stringify({
          settings: {
            network_input_enabled: true,
            network_output_enabled: true,
            usb_output_enabled: true,
          },
        })
      : relativeDirectory;
  writeFileSync(join(directory, filename), contents, "utf8");
}

/** Reads the transport settings from one copied test showfile. */
function readShowfileSettings(runDataDir, showfileName) {
  return JSON.parse(
    readFileSync(join(runDataDir, showfileName, "showfile.json"), "utf8"),
  ).settings;
}

/** Verifies an already-sanitized run seed is not rewritten for every test clone. */
test("disabled Playwright transports do not rewrite showfiles", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nightfall-seed-test-"));
  try {
    writeSeedFile(fixtureRoot, "default.nightfall-show", "showfile.json");
    const showfilePath = join(
      fixtureRoot,
      "default.nightfall-show",
      "showfile.json",
    );

    assert.equal(disablePlaywrightShowfileTransports(showfilePath), true);
    const sanitizedContents = readFileSync(showfilePath, "utf8");
    assert.equal(disablePlaywrightShowfileTransports(showfilePath), false);
    assert.equal(readFileSync(showfilePath, "utf8"), sanitizedContents);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

/** Verifies test clones stay isolated from their sanitized run seed. */
test("Playwright test data clones preserve the run seed", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nightfall-seed-test-"));
  let runSeedDataDir;
  let testDataDir;
  try {
    writeSeedFile(fixtureRoot, "default.nightfall-show", "showfile.json");
    writeSeedFile(fixtureRoot, "sample.nightfall-show", "showfile.json");
    ({ runDataDir: runSeedDataDir } = preparePlaywrightDataDir(fixtureRoot));
    ({ runDataDir: testDataDir } = clonePlaywrightDataDir(runSeedDataDir));

    const relativeShowfilePath = join(
      "default.nightfall-show",
      "showfile.json",
    );
    assert.deepEqual(
      readShowfileSettings(testDataDir, "default.nightfall-show"),
      {
        network_input_enabled: false,
        network_output_enabled: false,
        usb_output_enabled: false,
      },
    );
    writeFileSync(
      join(testDataDir, relativeShowfilePath),
      "test mutation",
      "utf8",
    );
    assert.notEqual(
      readFileSync(join(runSeedDataDir, relativeShowfilePath), "utf8"),
      "test mutation",
    );
  } finally {
    if (testDataDir) rmSync(testDataDir, { force: true, recursive: true });
    if (runSeedDataDir) {
      rmSync(runSeedDataDir, { force: true, recursive: true });
    }
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

/** Verifies an exported data directory overrides worktree dotenv configuration. */
test("exported Nightfall data directory overrides worktree dotenv", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "nightfall-worktree-test-"));
  try {
    writeFileSync(
      join(worktreeRoot, ".env"),
      "NIGHTFALL_DATA_DIR=dotenv-data\n",
      "utf8",
    );

    assert.equal(
      await nightfallDataDirForTestProcess(worktreeRoot, {
        NIGHTFALL_DATA_DIR: "exported-data",
      }),
      join(worktreeRoot, "exported-data"),
    );
  } finally {
    rmSync(worktreeRoot, { force: true, recursive: true });
  }
});

/** Verifies worktree dotenv configuration supplies the Playwright seed root. */
test("worktree dotenv supplies the Nightfall data directory", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "nightfall-worktree-test-"));
  try {
    writeFileSync(
      join(worktreeRoot, ".env"),
      "NIGHTFALL_DATA_DIR=dotenv-data\n",
      "utf8",
    );

    assert.equal(
      await nightfallDataDirForTestProcess(worktreeRoot, {}),
      join(worktreeRoot, "dotenv-data"),
    );
  } finally {
    rmSync(worktreeRoot, { force: true, recursive: true });
  }
});

/** Verifies missing configuration falls back to the platform application root. */
test("missing data directory configuration uses the platform root", async () => {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "nightfall-worktree-test-"));
  try {
    const env = { HOME: worktreeRoot, USERPROFILE: worktreeRoot };
    assert.equal(
      await nightfallDataDirForTestProcess(worktreeRoot, env),
      defaultNightfallDataDir(env),
    );
  } finally {
    rmSync(worktreeRoot, { force: true, recursive: true });
  }
});

/** Verifies Playwright copies stable seed entries without transient run state. */
test("Playwright data roots contain only stable seed entries", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nightfall-seed-test-"));
  let runDataDir;
  try {
    writeSeedFile(fixtureRoot, "default.nightfall-show", "showfile.json");
    writeSeedFile(fixtureRoot, "sample.nightfall-show", "showfile.json");
    writeSeedFile(fixtureRoot, "fixtures");
    writeSeedFile(fixtureRoot, "fx-modules");
    writeSeedFile(fixtureRoot, "objects");
    writeSeedFile(fixtureRoot, "drafts/default.nightfall-show");
    writeSeedFile(fixtureRoot, "backups/default-123.nightfall-show");
    writeSeedFile(fixtureRoot, "test-created.nightfall-show", "showfile.json");

    assert.equal(playwrightSeedDataAvailable(fixtureRoot), true);
    ({ runDataDir } = preparePlaywrightDataDir(fixtureRoot));

    assert.equal(existsSync(join(runDataDir, "default.nightfall-show")), true);
    assert.equal(existsSync(join(runDataDir, "sample.nightfall-show")), true);
    assert.equal(existsSync(join(runDataDir, "fixtures")), true);
    assert.equal(existsSync(join(runDataDir, "fx-modules")), true);
    assert.equal(existsSync(join(runDataDir, "objects")), true);
    assert.deepEqual(
      readShowfileSettings(runDataDir, "default.nightfall-show"),
      {
        network_input_enabled: false,
        network_output_enabled: false,
        usb_output_enabled: false,
      },
    );
    assert.deepEqual(
      readShowfileSettings(runDataDir, "sample.nightfall-show"),
      {
        network_input_enabled: false,
        network_output_enabled: false,
        usb_output_enabled: false,
      },
    );
    assert.equal(existsSync(join(runDataDir, "drafts")), false);
    assert.equal(existsSync(join(runDataDir, "backups")), false);
    assert.equal(
      existsSync(join(runDataDir, "test-created.nightfall-show")),
      false,
    );
  } finally {
    if (runDataDir) rmSync(runDataDir, { force: true, recursive: true });
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

/** Verifies missing saved showfiles request backend sample-data bootstrap. */
test("missing Playwright seed creates an empty disposable root", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nightfall-seed-test-"));
  let runDataDir;
  try {
    const missingSeedRoot = join(fixtureRoot, "missing");
    assert.equal(playwrightSeedDataAvailable(missingSeedRoot), false);

    const prepared = preparePlaywrightDataDir(missingSeedRoot, fixtureRoot);
    runDataDir = prepared.runDataDir;

    assert.equal(prepared.seedDataAvailable, false);
    assert.equal(existsSync(runDataDir), true);
  } finally {
    if (runDataDir) rmSync(runDataDir, { force: true, recursive: true });
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

/** Verifies incomplete saved showfiles use backend sample-data bootstrap. */
test("incomplete Playwright seed creates an empty disposable root", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nightfall-seed-test-"));
  let runDataDir;
  try {
    writeSeedFile(fixtureRoot, "default.nightfall-show", "showfile.json");
    mkdirSync(join(fixtureRoot, "sample.nightfall-show"));
    assert.equal(playwrightSeedDataAvailable(fixtureRoot), false);

    const prepared = preparePlaywrightDataDir(fixtureRoot, fixtureRoot);
    runDataDir = prepared.runDataDir;

    assert.equal(prepared.seedDataAvailable, false);
    assert.equal(existsSync(join(runDataDir, "default.nightfall-show")), false);
    assert.equal(existsSync(join(runDataDir, "sample.nightfall-show")), false);
  } finally {
    if (runDataDir) rmSync(runDataDir, { force: true, recursive: true });
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
