// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type BeamOptics, BeamType } from "../../../../types";
import {
  emitterDistributionArea,
  type ResolvedEmitterOptics,
  resolveEmitterOptics,
} from "./emitter-optics";

/** CPU reference of the shaders' relative irradiance at an emitter-local point. */
function sampleEmitterDistribution(
  optics: ResolvedEmitterOptics,
  x: number,
  y: number,
  distance: number,
): number {
  if (distance < 0) return 0;
  const u = x / (optics.radius + distance * optics.slopeX);
  const v = y / (optics.radius + distance * optics.slopeY);
  const radius =
    optics.shape === "rectangle"
      ? Math.max(Math.abs(u), Math.abs(v))
      : Math.hypot(u, v);
  if (radius > 2) return 0;
  return Math.exp(-Math.log(10) * radius ** optics.distributionPower);
}

/** CPU reference of flux per square metre on a plane perpendicular to the beam axis. */
function sampleEmitterIlluminance(
  optics: ResolvedEmitterOptics,
  x: number,
  y: number,
  distance: number,
): number {
  if (distance < 0) return 0;
  const width = optics.radius + distance * optics.slopeX;
  const height = optics.radius + distance * optics.slopeY;
  return (
    (optics.lumens * sampleEmitterDistribution(optics, x, y, distance)) /
    (emitterDistributionArea(optics.shape, optics.distributionPower) *
      width *
      height)
  );
}

/** Creates independent source metadata with a 4-degree beam and 8-degree field. */
function aperture(): BeamOptics {
  return {
    radius: 0.01,
    throwRatio: 2,
    rectangleRatio: 8,
    physical: {
      beamType: BeamType.Spot,
      beamAngle: 4,
      fieldAngle: 8,
      lumens: 500,
    },
  };
}

/** GDTF beam/field angles specify intensity contours, not the endpoints of zoom. */
test("emitter optics retain half-power and field contours independently of zoom", () => {
  const optics = resolveEmitterOptics(aperture())!;
  const width = optics.radius + 10 * optics.slopeX;
  assert.ok(
    Math.abs(sampleEmitterDistribution(optics, width, 0, 10) - 0.1) < 1e-9,
  );
  assert.ok(
    Math.abs(
      sampleEmitterDistribution(optics, width * optics.halfPowerRatio, 0, 10) -
        0.5,
    ) < 1e-9,
  );
  const zoomed = resolveEmitterOptics(aperture(), 2)!;
  assert.ok(zoomed.slopeX < optics.slopeX);
  assert.equal(zoomed.halfPowerRatio, optics.halfPowerRatio);
});

/** Numerically integrating an axial plane must recover the source flux at different widths, distances and profiles. */
test("beam spreading conserves flux for round and rectangular apertures", () => {
  for (const shape of ["round", "rectangle"] as const)
    for (const distributionPower of [0.1, 1, 2, 8, 64])
      for (const distance of [0.25, 5]) {
        const optics = {
          ...resolveEmitterOptics(aperture())!,
          shape,
          distributionPower,
        };
        const width = optics.radius + distance * optics.slopeX;
        const height = optics.radius + distance * optics.slopeY;
        const samples = 160;
        const dx = (4 * width) / samples;
        const dy = (4 * height) / samples;
        let flux = 0;
        for (let x = 0; x < samples; x++)
          for (let y = 0; y < samples; y++)
            flux +=
              sampleEmitterIlluminance(
                optics,
                (x + 0.5) * dx - 2 * width,
                (y + 0.5) * dy - 2 * height,
                distance,
              ) *
              dx *
              dy;
        assert.ok(
          Math.abs(flux / optics.lumens - 1) < 0.01,
          `${shape}, power=${distributionPower}, distance=${distance}: ${flux}`,
        );
      }
});

/** Narrowing zoom concentrates the same flux instead of merely shrinking an equally bright distribution. */
test("narrow beams become brighter without changing emitter flux", () => {
  const wide = resolveEmitterOptics(aperture(), 8)!;
  const narrow = resolveEmitterOptics(aperture(), 2)!;
  assert.equal(narrow.lumens, wide.lumens);
  assert.ok(
    sampleEmitterIlluminance(narrow, 0, 0, 10) >
      sampleEmitterIlluminance(wide, 0, 0, 10) * 10,
  );
  assert.ok(Number.isFinite(sampleEmitterIlluminance(narrow, 0, 0, 0)));
  assert.equal(sampleEmitterIlluminance(narrow, 0, 0, -1), 0);
});

/** Rectangular projection follows each aperture's throw/aspect data rather than fixture names. */
test("rectangular emitters preserve their own projection and glow remains non-projecting", () => {
  const data = aperture();
  data.physical.beamType = BeamType.Rectangle;
  const optics = resolveEmitterOptics(data)!;
  assert.equal(optics.slopeX, 0.25);
  assert.equal(optics.slopeY, 0.03125);
  assert.ok(
    sampleEmitterDistribution(optics, 1, 0, 10) >
      sampleEmitterDistribution(optics, 0, 1, 10),
  );
  data.physical.beamType = BeamType.Glow;
  assert.equal(resolveEmitterOptics(data), undefined);
});

/** A line of individual narrow sources forms a continuous sheet after their distributions overlap. */
test("overlapping emitters form a continuous blade without merging their apertures", () => {
  const optics = resolveEmitterOptics(aperture())!;
  const sources = Array.from({ length: 60 }, (_, i) => (i - 29.5) * 0.025);
  const sample = (x: number, y: number) =>
    sources.reduce(
      (sum, source) =>
        sum + sampleEmitterDistribution(optics, x - source, y, 1),
      0,
    );
  assert.ok(sample(0, 0) > sample(0, 0.3) * 100);
  assert.ok(sample(0.0125, 0) / sample(0, 0) > 0.95);
  assert.ok(sample(0.0125, 0) / sample(0, 0) < 1.05);
});
