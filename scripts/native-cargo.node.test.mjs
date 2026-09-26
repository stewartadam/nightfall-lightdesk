// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { nativeCargoArgs } from "./run-native-cargo.mjs";

/** Guard native CI coverage when workspace crates acquire new default features. */
test("static native selection retains every functional workspace default", () => {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version=1"], {
      encoding: "utf8",
    }),
  );
  const args = nativeCargoArgs("test");
  assert.equal(args[args.indexOf("--exclude") + 1], "app-tauri");
  const features = new Set(args[args.indexOf("--features") + 1].split(","));
  for (const pkg of metadata.packages) {
    if (pkg.name === "app-tauri") continue;
    for (const feature of pkg.features.default ?? []) {
      if (pkg.name === "app-runtime" && feature === "bevy_dynamic") continue;
      assert.ok(
        features.has(`${pkg.name}/${feature}`),
        `Native CI must retain ${pkg.name}/${feature}`,
      );
    }
  }
});

/** Runtime-only builds must not pull a WebView or Tauri build script into native validation. */
test("the full runtime dependency graph excludes Tauri", () => {
  const graph = execFileSync(
    "cargo",
    [
      "tree",
      "-p",
      "app-runtime",
      "--no-default-features",
      "--features",
      "full,beatgrid-detect",
      "--prefix",
      "none",
      "--format",
      "{p}",
    ],
    { encoding: "utf8" },
  );
  assert.doesNotMatch(graph, /^(?:app-tauri|tauri(?:-[\w-]+)?) v/m);
});

/** Guard artifact reuse between the Playwright backend build and the nextest run. */
test("nextest selects the same targets and features as the backend build", () => {
  const nextestArgs = nativeCargoArgs("nextest");
  const buildArgs = nativeCargoArgs("build");
  assert.deepEqual(nextestArgs.slice(0, 2), ["nextest", "run"]);
  assert.deepEqual(nextestArgs.slice(2), buildArgs.slice(1));
});
