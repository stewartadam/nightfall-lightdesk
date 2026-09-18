// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowStartupSplash, startupPhaseForLifecycle } from "./model";

/** Verifies lifecycle phases map to the compact splash status vocabulary. */
test("startupPhaseForLifecycle maps loading and interactive phases", () => {
  assert.equal(startupPhaseForLifecycle("backend-connecting"), "waiting");
  assert.equal(
    startupPhaseForLifecycle("startup-loading-draft"),
    "loading-draft",
  );
  assert.equal(startupPhaseForLifecycle("interactive"), "ready");
});

/** Verifies prompt phases remove the splash unless an explicit hold is active. */
test("shouldShowStartupSplash respects lifecycle and minimum-visible hold", () => {
  assert.equal(
    shouldShowStartupSplash("startup-showfile-prompt", false),
    false,
  );
  assert.equal(shouldShowStartupSplash("startup-showfile-prompt", true), true);
  assert.equal(shouldShowStartupSplash("startup-loading-saved", false), true);
});
