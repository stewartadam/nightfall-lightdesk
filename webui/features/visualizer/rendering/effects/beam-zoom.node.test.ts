// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BeamType } from "../../../../types";
import { beamConeAngleDegrees } from "./beam-zoom";
import { resolveEmitterOptics } from "./emitter-optics";

/** Zoom travel must not double as a broad field contour at the focused endpoint. */
test("linear aperture arrays stay thin at full zoom and spread at wide zoom", () => {
  const physical = {
    beamType: BeamType.Wash,
    beamAngle: 1,
    fieldAngle: 1.2,
    zoomRange: { narrow: 1, wide: 34 },
  };
  const optics = { physical, radius: 0.034, throwRatio: 1, rectangleRatio: 1 };
  const focused = resolveEmitterOptics(
    optics,
    beamConeAngleDegrees(1, 1.2, 1, physical.zoomRange),
  )!;
  const wide = resolveEmitterOptics(
    optics,
    beamConeAngleDegrees(1, 1.2, 0, physical.zoomRange),
  )!;
  assert.ok(2 * (focused.radius + 10 * focused.slopeY) < 0.3);
  assert.ok(2 * (wide.radius + 10 * wide.slopeY) > 7);
  assert.equal(focused.distributionPower, wide.distributionPower);
});

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
