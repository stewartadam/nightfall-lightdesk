// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  describeRestore,
  findUnitDirectories,
  readUnits,
  renderReport,
  summarizeUnits,
  unitPackage,
} from "./cargo-cache-report.mjs";

/** Restore outcomes distinguish exact hits, fallback restores and cold starts. */
test("describes exact, partial and missed restores", () => {
  assert.equal(
    describeRestore({
      exactHit: true,
      targetsCached: true,
      artifactsPresent: true,
    }),
    "exact hit",
  );
  assert.equal(
    describeRestore({
      exactHit: false,
      targetsCached: true,
      artifactsPresent: true,
    }),
    "partial hit (older cache)",
  );
  assert.equal(
    describeRestore({
      exactHit: false,
      targetsCached: true,
      artifactsPresent: false,
    }),
    "miss",
  );
  assert.equal(
    describeRestore({
      exactHit: false,
      targetsCached: false,
      artifactsPresent: false,
    }),
    "no exact hit",
  );
});

/** Package names keep their dashes and lose only Cargo's 16-digit metadata hash. */
test("derives package names from fingerprint directories", () => {
  assert.equal(unitPackage("proc-macro2-8c620669baf7394b"), "proc-macro2");
  assert.equal(
    unitPackage("nightfall-engine-0123456789abcdef"),
    "nightfall-engine",
  );
  assert.equal(unitPackage("no-hash"), "no-hash");
});

/** Units written after the restore count as rebuilt; workspace members are tallied separately. */
test("splits units into cached and rebuilt by restore time", () => {
  const restoredAt = 1_000_000;
  const summary = summarizeUnits(
    [
      { package: "serde", modifiedMs: restoredAt - 60_000 },
      { package: "serde", modifiedMs: restoredAt + 5_000 },
      { package: "tokio", modifiedMs: restoredAt - 60_000 },
      { package: "nightfall-engine", modifiedMs: restoredAt + 5_000 },
      { package: "nightfall-dmx", modifiedMs: restoredAt - 60_000 },
    ],
    new Set(["nightfall-engine", "nightfall-dmx"]),
    restoredAt,
  );
  assert.equal(summary.dependencies.cached, 2);
  assert.equal(summary.dependencies.rebuilt, 1);
  assert.deepEqual([...summary.dependencies.rebuiltPackages], ["serde"]);
  assert.equal(summary.workspace.cached, 1);
  assert.equal(summary.workspace.rebuilt, 1);
});

/** The summary leads with rebuilt counts and truncates long rebuilt lists. */
test("renders the job summary", () => {
  const summary = {
    dependencies: {
      cached: 3,
      rebuilt: 1,
      rebuiltPackages: new Set(["zeta", "alpha"]),
    },
    workspace: {
      cached: 0,
      rebuilt: 5,
      rebuiltPackages: new Set(["nightfall"]),
    },
  };
  const markdown = renderReport({
    label: "native",
    restore: "exact hit",
    summary,
    rebuiltListLimit: 1,
  });
  assert.match(markdown, /^### Rust cache: native$/m);
  assert.match(markdown, /Restore: \*\*exact hit\*\*/);
  assert.match(markdown, /\| Dependencies \| 3 \| 1 \|/);
  assert.match(markdown, /\| Workspace \| 0 \| 5 \|/);
  assert.match(
    markdown,
    /Rebuilt \*\*1\*\* dependency units \(2 packages\) and \*\*5\*\* workspace units\./,
  );
  assert.match(markdown, /Rebuilt dependencies: `alpha`, and 1 more\./);
  assert.match(markdown, /exact-hit cache was missing these units/);
  assert.doesNotMatch(
    renderReport({
      label: "native",
      restore: "partial hit (older cache)",
      summary,
    }),
    /exact-hit cache was missing/,
  );

  const toolsOnly = renderReport({
    label: "source-tools",
    restore: "no exact hit",
  });
  assert.equal(
    toolsOnly,
    "### Rust cache: source-tools\n\nRestore: **no exact hit**\n",
  );
});

/** Units are found in both Cargo layouts, for host and per-target-triple profiles, using each unit's newest file. */
test("reads units from classic and per-package layouts", () => {
  const root = mkdtempSync(join(tmpdir(), "cargo-cache-report-"));
  try {
    /** Create one fingerprint directory whose files carry the given modification times in seconds. */
    function fingerprint(relativePath, mtimes) {
      const directory = join(root, relativePath);
      mkdirSync(directory, { recursive: true });
      mtimes.forEach((mtime, index) => {
        const file = join(directory, `file-${index}`);
        writeFileSync(file, "");
        utimesSync(file, mtime, mtime);
      });
    }
    fingerprint("debug/.fingerprint/proc-macro2-8c620669baf7394b", [100]);
    fingerprint(
      "x86_64-pc-windows-msvc/release/build/serde/0123456789abcdef/fingerprint",
      [100, 300],
    );
    fingerprint("release/build/syn/fedcba9876543210/fingerprint", [200]);
    // Classic build-script output directories and non-profile trees hold no units.
    mkdirSync(
      join(root, "debug", "build", "proc-macro2-8c620669baf7394b", "out"),
      { recursive: true },
    );
    mkdirSync(join(root, "doc", "serde"), { recursive: true });

    const units = readUnits(findUnitDirectories(root)).sort((a, b) =>
      a.package.localeCompare(b.package),
    );
    assert.deepEqual(units, [
      { package: "proc-macro2", modifiedMs: 100_000 },
      { package: "serde", modifiedMs: 300_000 },
      { package: "syn", modifiedMs: 200_000 },
    ]);
    assert.deepEqual(findUnitDirectories(join(root, "missing")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
