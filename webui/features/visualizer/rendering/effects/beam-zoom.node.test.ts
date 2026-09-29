// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BeamType } from "../../../../types";
import { MIN_CONE_ANGLE_DEGREES } from "./beam-zoom";
import {
  emitterZoomScale,
  resolveEmitterOptics,
  zoomedBeamAngleDegrees,
} from "./emitter-optics";

/** Half-width per metre of a full cone angle, for comparing zoom scales against angles. */
function slope(degrees: number): number {
  return Math.tan((degrees * Math.PI) / 360);
}

/** Verifies a profile-stated zoom angle replaces the aperture's native spread. */
test("emitter zoom scale follows a stated zoom angle", () => {
  const physical = { beamType: BeamType.Spot, beamAngle: 8, fieldAngle: 40 };
  assert.ok(
    Math.abs(emitterZoomScale(physical, 12) - slope(12) / slope(8)) < 1e-12,
  );
});

/** Verifies zero or negative stated zoom angles still render a visible cone instead of the native one. */
test("emitter zoom scale floors nonpositive zoom angles", () => {
  const physical = { beamType: BeamType.Spot, beamAngle: 8, fieldAngle: 40 };
  const floor = slope(MIN_CONE_ANGLE_DEGREES) / slope(8);
  for (const zoom of [0, -5, 0.1])
    assert.ok(Math.abs(emitterZoomScale(physical, zoom) - floor) < 1e-12);
  assert.ok(floor > 0);
});

/** Degree-valued zoom travel must not double as a broad field contour at the focused endpoint. */
test("linear aperture arrays stay thin at full zoom and spread at wide zoom", () => {
  const physical = {
    beamType: BeamType.Wash,
    beamAngle: 1,
    fieldAngle: 1.2,
  };
  const optics = { physical, radius: 0.034, throwRatio: 1, rectangleRatio: 1 };
  const focused = resolveEmitterOptics(optics, 1)!;
  const wide = resolveEmitterOptics(optics, 34)!;
  assert.ok(2 * (focused.radius + 10 * focused.slopeY) < 0.3);
  assert.ok(2 * (wide.radius + 10 * wide.slopeY) > 7);
  assert.equal(focused.distributionPower, wide.distributionPower);
});

/** Full angle, in degrees, of the rendered field (10%) edge of an aperture at a zoom input. */
function fieldEdgeDegrees(
  physical: { beamType: BeamType; beamAngle: number; fieldAngle: number },
  zoomDegrees: number | undefined,
  zoom: number | undefined,
): number {
  const optics = { physical, radius: 0, throwRatio: 1, rectangleRatio: 1 };
  const zoomed = zoomedBeamAngleDegrees(physical, zoomDegrees, zoom);
  const resolved = resolveEmitterOptics(optics, zoomed)!;
  return (360 / Math.PI) * Math.atan(resolved.slopeX);
}

/**
 * A 15°/30° built-in head's normalized zoom sweeps the visible field edge across the same
 * 30°→15° cone the hard-edged renderer drew, rather than widening the field a second time.
 */
test("normalized zoom sweeps the field edge across the native range", () => {
  const head = { beamType: BeamType.Spot, beamAngle: 15, fieldAngle: 30 };
  const near = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);
  near(fieldEdgeDegrees(head, undefined, 0), 30);
  near(fieldEdgeDegrees(head, undefined, 0.5), 22.5);
  near(fieldEdgeDegrees(head, undefined, 1), 15);
  near(zoomedBeamAngleDegrees(head, undefined, 0)!, 15);
  near(fieldEdgeDegrees(head, undefined, -1), 30);
  near(fieldEdgeDegrees(head, undefined, 2), 15);
});

/** An aperture without a zoom channel keeps its native optics instead of a mid-zoom guess. */
test("missing or non-finite zoom keeps native optics", () => {
  const head = { beamType: BeamType.Spot, beamAngle: 15, fieldAngle: 30 };
  for (const zoom of [undefined, NaN, Infinity, -Infinity])
    assert.equal(zoomedBeamAngleDegrees(head, undefined, zoom), undefined);
  assert.ok(Math.abs(fieldEdgeDegrees(head, undefined, undefined) - 30) < 1e-9);
});

/** A stated zoom angle is the beam angle itself and wins over the normalized position. */
test("stated zoom degrees take precedence over normalized zoom", () => {
  const head = { beamType: BeamType.Spot, beamAngle: 15, fieldAngle: 30 };
  assert.equal(zoomedBeamAngleDegrees(head, 34, 0.25), 34);
  assert.equal(zoomedBeamAngleDegrees(head, 0, 0.25), 0);
});

/** Zoom slopes stay finite for degenerate, missing and out-of-range angles. */
test("emitter zoom scale clamps angles and ignores non-finite zoom", () => {
  const physical = { beamType: BeamType.Spot, beamAngle: 10, fieldAngle: 20 };
  assert.equal(emitterZoomScale(physical, undefined), 1);
  assert.equal(emitterZoomScale(physical, NaN), 1);
  assert.equal(emitterZoomScale(physical, 10), 1);
  assert.ok(emitterZoomScale(physical, 20) > 2);
  assert.equal(
    emitterZoomScale(physical, 500),
    emitterZoomScale(physical, 170),
  );
  assert.equal(emitterZoomScale({ ...physical, beamAngle: 0 }, 30), 1);
});
