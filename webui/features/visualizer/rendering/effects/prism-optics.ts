// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { OpticalPrismFacet } from "../../../../types";

/** A compiled affine projection, in units of the unsplit beam radius. */
export interface PrismProjection {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
  determinant: number;
  red: number;
  green: number;
  blue: number;
}

/** One active prism stage, ordered from the source toward the output aperture. */
export interface PrismStage {
  facets: readonly PrismProjection[];
  rotation: number;
}

/** Creates writable identity storage before playback starts. */
function identityProjection(): PrismProjection {
  return {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    x: 0,
    y: 0,
    determinant: 1,
    red: 1,
    green: 1,
    blue: 1,
  };
}

/** Composes prism combinations while reusing preallocated facet records during playback. */
export class PrismStack {
  private readonly buffers: [PrismProjection[], PrismProjection[]];
  private readonly results = new Map<number, PrismProjection[]>();

  /** Reserves the maximum supported product of active facet counts at fixture preparation. */
  constructor(
    readonly capacity: number,
    preparedCounts: Iterable<number> = [capacity],
    private readonly reduceOverflow = false,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("Prism capacity must be a positive safe integer");
    this.buffers = [
      Array.from({ length: capacity }, identityProjection),
      Array.from({ length: capacity }, identityProjection),
    ];
    for (const count of preparedCounts) {
      if (!Number.isSafeInteger(count) || count < 1 || count > capacity)
        throw new RangeError("Prepared prism count must fit capacity");
      this.results.set(count, this.buffers[0].slice(0, count));
    }
  }

  /** Applies rotated stages using prepared lists; optional reduction samples oversized combinations within capacity. */
  compose(
    stages: readonly PrismStage[],
  ): readonly PrismProjection[] | undefined {
    let required = 1;
    let active = 0;
    for (const stage of stages) {
      if (!stage.facets.length) continue;
      required *= stage.facets.length;
      if (required > this.capacity) {
        if (!this.reduceOverflow)
          throw new RangeError("Prism combination exceeds prepared capacity");
        required = this.capacity;
      }
      active++;
    }
    if (!active) return undefined;
    const result = this.results.get(required);
    if (!result)
      throw new RangeError("Prism combination count was not prepared");
    let source = this.buffers[0];
    let destination = this.buffers[1];
    const identity = source[0];
    identity.a =
      identity.d =
      identity.determinant =
      identity.red =
      identity.green =
      identity.blue =
        1;
    identity.b = identity.c = identity.x = identity.y = 0;
    let count = 1;
    for (const stage of stages) {
      if (!stage.facets.length) continue;
      const cos = Math.cos(stage.rotation);
      const sin = Math.sin(stage.rotation);
      const combinations = count * stage.facets.length;
      const written = Math.min(this.capacity, combinations);
      for (let i = 0; i < written; i++) {
        // Spread retained samples across the full stage, rather than dropping later wheels.
        const combination =
          written === combinations
            ? i
            : written === 1
              ? Math.floor(combinations / 2)
              : Math.floor((i * (combinations - 1)) / (written - 1));
        const incoming = source[Math.floor(combination / stage.facets.length)];
        const facet = stage.facets[combination % stage.facets.length];
        const a = cos * facet.a - sin * facet.c;
        const b = cos * facet.b - sin * facet.d;
        const c = sin * facet.a + cos * facet.c;
        const d = sin * facet.b + cos * facet.d;
        const output = destination[i];
        output.a = a * incoming.a + b * incoming.c;
        output.b = a * incoming.b + b * incoming.d;
        output.c = c * incoming.a + d * incoming.c;
        output.d = c * incoming.b + d * incoming.d;
        output.x =
          a * incoming.x + b * incoming.y + cos * facet.x - sin * facet.y;
        output.y =
          c * incoming.x + d * incoming.y + sin * facet.x + cos * facet.y;
        output.determinant = incoming.determinant * facet.determinant;
        output.red = incoming.red * facet.red;
        output.green = incoming.green * facet.green;
        output.blue = incoming.blue * facet.blue;
      }
      count = written;
      const previous = source;
      source = destination;
      destination = previous;
    }
    for (let i = 0; i < count; i++) result[i] = source[i];
    return result;
  }
}

/** Rejects degenerate facets and converts xyY transmission into linear RGB once at fixture load. */
export function compilePrismFacet(
  facet: OpticalPrismFacet,
): PrismProjection | undefined {
  const m = facet.transform;
  const determinant = m[0] * m[4] - m[3] * m[1];
  if (
    !m.every(Number.isFinite) ||
    !facet.colorCie.every(Number.isFinite) ||
    Math.abs(determinant) < 1e-8 ||
    Math.abs(m[2]) > 1e-6 ||
    Math.abs(m[5]) > 1e-6 ||
    Math.abs(m[8] - 1) > 1e-6
  )
    return undefined;
  const [x, y, luminance] = facet.colorCie;
  const Y = Math.max(0, luminance / 100);
  const X = y > 1e-8 ? (x * Y) / y : 0;
  const Z = y > 1e-8 ? ((1 - x - y) * Y) / y : 0;
  return {
    a: m[0],
    b: m[3],
    c: m[1],
    d: m[4],
    x: m[6],
    y: m[7],
    determinant,
    red: Math.max(0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z),
    green: Math.max(0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z),
    blue: Math.max(0, 0.0557 * X - 0.204 * Y + 1.057 * Z),
  };
}
