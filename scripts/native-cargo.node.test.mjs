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
  const features = new Set(args[args.indexOf("--features") + 1].split(","));
  for (const pkg of metadata.packages) {
    for (const feature of pkg.features.default ?? []) {
      if (pkg.name === "nightfall-app" && feature === "bevy_dynamic") continue;
      assert.ok(
        features.has(`${pkg.name}/${feature}`),
        `Native CI must retain ${pkg.name}/${feature}`,
      );
    }
  }
});
