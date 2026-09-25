// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Light proxies stand in for a fixture's beams when lighting stage surfaces.
 *
 * Pixel fixtures (bars, rings, liquid heads) emit through dozens of beams,
 * but from the audience they read as one fixture or a few segments of it,
 * and a real light per beam makes every lit shader loop over every beam.
 * Beams of each fixture are grouped into a few segments along the fixture's
 * longest extent; each segment becomes one proxy carrying the segment's
 * summed output, intensity-weighted color, centroid and a cone covering its
 * beams. Volumetric beams and emitter surfaces stay per beam.
 */

import { Vector3 } from "three/webgpu";

/** Target size of one lighting segment along a fixture, in meters. */
export const PROXY_SEGMENT_LENGTH = 0.4;

/** Most proxies one fixture contributes. */
export const MAX_PROXIES_PER_FIXTURE = 4;

/** Widest cone a proxy may use, just under the spot light limit of 90°. */
const MAX_PROXY_HALF_ANGLE = Math.PI / 2 - 0.05;

/** One lit beam as seen by surface lighting. */
export interface BeamLightSample {
  /** Fixture the beam belongs to. */
  fixtureUid: string;
  /** World position of the beam's origin, in meters. */
  position: Vector3;
  /** Unit world direction of the beam. */
  direction: Vector3;
  /** Half cone angle in radians. */
  halfAngle: number;
  /** Light intensity (candela-like units used by the spot light). */
  intensity: number;
  /** Linear color, 0-1 per channel. */
  red: number;
  green: number;
  blue: number;
  /** Gobo image the beam projects, if any. */
  gobo?: unknown;
}

/** A light standing in for one segment of a fixture's beams. */
export interface BeamLightProxy {
  /** Fixture the proxy belongs to. */
  fixtureUid: string;
  /** Intensity-weighted world origin. */
  position: Vector3;
  /** Unit world direction. */
  direction: Vector3;
  /** Half cone angle covering every member beam. */
  halfAngle: number;
  /** Summed member intensity. */
  intensity: number;
  /** Intensity-weighted linear color. */
  red: number;
  green: number;
  blue: number;
  /** Gobo image, kept only when the proxy stands for a single beam. */
  gobo?: unknown;
  /** Number of beams the proxy stands for. */
  beamCount: number;
}

/**
 * Groups lit beams into light proxies, at most {@link MAX_PROXIES_PER_FIXTURE}
 * per fixture, segmenting each fixture along its longest extent.
 */
export function buildBeamLightProxies(
  samples: readonly BeamLightSample[],
): BeamLightProxy[] {
  const byFixture = new Map<string, BeamLightSample[]>();
  for (const sample of samples) {
    if (sample.intensity <= 0) continue;
    const list = byFixture.get(sample.fixtureUid);
    if (list) list.push(sample);
    else byFixture.set(sample.fixtureUid, [sample]);
  }

  const proxies: BeamLightProxy[] = [];
  for (const beams of byFixture.values()) {
    for (const segment of segmentBeams(beams)) {
      proxies.push(proxyFor(segment));
    }
  }
  return proxies;
}

/** Splits one fixture's beams into segments along the axis of its greatest extent. */
function segmentBeams(beams: BeamLightSample[]): BeamLightSample[][] {
  if (beams.length === 1) return [beams];
  const min = beams[0].position.clone();
  const max = beams[0].position.clone();
  for (const beam of beams) {
    min.min(beam.position);
    max.max(beam.position);
  }
  const extent = max.clone().sub(min);
  const axis: "x" | "y" | "z" =
    extent.x >= extent.y && extent.x >= extent.z
      ? "x"
      : extent.y >= extent.z
        ? "y"
        : "z";
  const length = extent[axis];
  const count = Math.min(
    MAX_PROXIES_PER_FIXTURE,
    Math.max(1, Math.ceil(length / PROXY_SEGMENT_LENGTH)),
  );
  if (count === 1) return [beams];

  const segments: BeamLightSample[][] = Array.from({ length: count }, () => []);
  for (const beam of beams) {
    const t = (beam.position[axis] - min[axis]) / length;
    segments[Math.min(count - 1, Math.floor(t * count))].push(beam);
  }
  return segments.filter((segment) => segment.length > 0);
}

/** Combines a segment's beams into one proxy. */
function proxyFor(beams: BeamLightSample[]): BeamLightProxy {
  let intensity = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  const position = new Vector3();
  const direction = new Vector3();
  for (const beam of beams) {
    intensity += beam.intensity;
    red += beam.red * beam.intensity;
    green += beam.green * beam.intensity;
    blue += beam.blue * beam.intensity;
    position.addScaledVector(beam.position, beam.intensity);
    direction.addScaledVector(beam.direction, beam.intensity);
  }
  position.divideScalar(intensity);
  if (direction.lengthSq() === 0) direction.copy(beams[0].direction);
  direction.normalize();

  let halfAngle = 0;
  for (const beam of beams) {
    const offset = Math.acos(
      Math.min(1, Math.max(-1, beam.direction.dot(direction))),
    );
    halfAngle = Math.max(halfAngle, beam.halfAngle + offset);
  }

  return {
    fixtureUid: beams[0].fixtureUid,
    position,
    direction,
    halfAngle: Math.min(MAX_PROXY_HALF_ANGLE, halfAngle),
    intensity,
    red: red / intensity,
    green: green / intensity,
    blue: blue / intensity,
    gobo: beams.length === 1 ? beams[0].gobo : undefined,
    beamCount: beams.length,
  };
}
