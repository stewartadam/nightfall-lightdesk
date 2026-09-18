// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  desktopArtifactPlan,
  desktopReleasePolicy,
  desktopTargets,
} from "./desktop-artifacts.mjs";

/** Branch builds, pull requests and manual runs never gain release-publication permission. */
test("only an exact version-tag push publishes a release", () => {
  for (const [event, ref] of [
    ["push", "refs/heads/main"],
    ["pull_request", "refs/pull/1/merge"],
    ["workflow_dispatch", "refs/tags/v0.1.0"],
  ]) {
    assert.equal(
      desktopReleasePolicy("0.1.0", "0.1.0", event, ref).publish,
      false,
    );
  }
  assert.deepEqual(
    desktopReleasePolicy("0.1.0", "0.1.0", "push", "refs/tags/v0.1.0"),
    { version: "0.1.0", publish: true, prerelease: false },
  );
  assert.equal(
    desktopReleasePolicy(
      "0.2.0-beta.1",
      "0.2.0-beta.1",
      "push",
      "refs/tags/v0.2.0-beta.1",
    ).prerelease,
    true,
  );
});

/** Version mismatches fail before publishing mislabeled installers. */
test("rejects mismatched or unsafe release versions", () => {
  assert.throws(
    () => desktopReleasePolicy("0.1.0", "0.2.0", "push", "refs/tags/v0.1.0"),
    /differs/,
  );
  assert.throws(
    () => desktopReleasePolicy("0.1.0", "0.1.0", "push", "refs/tags/v0.2.0"),
    /Release tag/,
  );
  assert.throws(
    () =>
      desktopReleasePolicy(
        "../installer",
        "../installer",
        "push",
        "refs/heads/main",
      ),
    /semantic version/,
  );
});

/** All platform installers get distinct filenames while Linux retains both distribution formats. */
test("stages the complete matrix without filename collisions", () => {
  const names = [];
  for (const platform of desktopTargets) {
    const paths = platform.extensions.map((ext) => `/build/Nightfall${ext}`);
    const plan = desktopArtifactPlan(platform.target, "0.1.0", [
      ...paths,
      "/build/Nightfall.app",
    ]);
    assert.equal(plan.length, platform.extensions.length);
    names.push(...plan.map((artifact) => artifact.filename));
  }
  assert.equal(names.length, 5);
  assert.equal(new Set(names).size, 5);
});

/** Missing or ambiguous build outputs prevent partial installers from reaching a release. */
test("rejects incomplete and ambiguous installer sets", () => {
  assert.throws(
    () =>
      desktopArtifactPlan("x86_64-unknown-linux-gnu", "0.1.0", [
        "/build/Nightfall.deb",
      ]),
    /AppImage/,
  );
  assert.throws(
    () =>
      desktopArtifactPlan("aarch64-apple-darwin", "0.1.0", [
        "one.dmg",
        "two.dmg",
      ]),
    /found 2/,
  );
  assert.throws(
    () => desktopArtifactPlan("unknown", "0.1.0", []),
    /Unknown desktop target/,
  );
});

/** The Actions output contract stages actual installer bytes under their published filename. */
test("stages an installer from the Tauri JSON output", () => {
  const directory = mkdtempSync(join(tmpdir(), "nightfall-desktop-artifacts-"));
  try {
    mkdirSync(join(directory, "crates/app"), { recursive: true });
    writeFileSync(
      join(directory, "crates/app/tauri.conf.json"),
      JSON.stringify({ version: "0.1.0" }),
    );
    const installer = join(directory, "Nightfall.dmg");
    writeFileSync(installer, "installer bytes");
    mkdirSync(join(directory, "webui/dist/notices"), { recursive: true });
    writeFileSync(
      join(directory, "webui/dist/notices/THIRD-PARTY-NOTICES.json"),
      JSON.stringify({ distribution: "Desktop — aarch64-apple-darwin" }),
    );
    writeFileSync(
      join(directory, "webui/dist/notices/THIRD-PARTY-NOTICES.txt"),
      "license bytes",
    );
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./desktop-artifacts.mjs", import.meta.url)),
        "stage",
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          DESKTOP_TARGET: "aarch64-apple-darwin",
          TAURI_ARTIFACT_PATHS: JSON.stringify([installer]),
        },
      },
    );
    assert.equal(
      readFileSync(
        join(
          directory,
          "desktop-artifacts/nightfall-v0.1.0-aarch64-apple-darwin.dmg",
        ),
        "utf8",
      ),
      "installer bytes",
    );
    assert.equal(
      readFileSync(
        join(
          directory,
          "desktop-artifacts/nightfall-v0.1.0-aarch64-apple-darwin-THIRD-PARTY-NOTICES.txt",
        ),
        "utf8",
      ),
      "license bytes",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
