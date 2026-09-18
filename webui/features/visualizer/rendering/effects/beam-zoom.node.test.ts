// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { beamConeAngleDegrees } from "./beam-zoom";

/** Verifies normalized zoom follows operator semantics where 100% is focused. */
test("beam cone angle narrows as zoom increases", () => {
  assert.equal(beamConeAngleDegrees(8, 40, 0), 40);
  assert.equal(beamConeAngleDegrees(8, 40, 0.5), 24);
  assert.equal(beamConeAngleDegrees(8, 40, 1), 8);
});

/** Verifies out-of-range zoom values clamp to the physical beam range. */
test("beam cone angle clamps zoom to the physical range", () => {
  assert.equal(beamConeAngleDegrees(8, 40, -1), 40);
  assert.equal(beamConeAngleDegrees(8, 40, 2), 8);
});
