// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { DataTexture, FloatType, RGBAFormat } from "three/webgpu";
import type { GoboStage } from "./emitter-optical-state";

/** Bounds mask samples per ray step independently of imported fixture complexity. */
export const MAX_GOBO_STAGES = 8;
const WIDTH = MAX_GOBO_STAGES + 1;

/** Shares one prepared mask stack between every prism facet, fog and receiving surface. */
export class GoboStackTable {
  private rows = 256;
  private data = new Float32Array(WIDTH * this.rows * 4);
  readonly texture = new DataTexture(
    this.data,
    WIDTH,
    this.rows,
    RGBAFormat,
    FloatType,
  );
  private readonly slots = new Map<string, number>();
  private readonly free: number[] = [];
  private next = 0;
  private readonly reduced = new Set<string>();

  /** Reports active stacks whose masks exceed the sampling budget. */
  get reducedStacks(): number {
    return this.reduced.size;
  }

  /** Reserves stable row addresses during fixture preparation; freed rows are reused. */
  reserve(id: string): number {
    const existing = this.slots.get(id);
    if (existing !== undefined) return existing;
    const row = this.free.pop() ?? this.next++;
    if (row >= this.rows) {
      this.rows *= 2;
      const data = new Float32Array(WIDTH * this.rows * 4);
      data.set(this.data);
      this.data = data;
      this.texture.image = { data, width: WIDTH, height: this.rows };
      this.texture.needsUpdate = true;
    }
    this.slots.set(id, row);
    return row;
  }

  /** Uploads only active masks and returns a negative stack address distinct from atlas tile indices. */
  update(id: string, stages: readonly GoboStage[]): number {
    const row = this.reserve(id);
    const offset = row * WIDTH * 4;
    let count = 0;
    let requested = 0;
    let changed = false;
    for (const stage of stages) {
      if (stage.slot <= 0) continue;
      requested++;
      if (count === MAX_GOBO_STAGES) continue;
      const index = offset + ++count * 4;
      const rotation = Math.fround(stage.rotation);
      if (
        this.data[index] !== stage.slot ||
        this.data[index + 1] !== rotation
      ) {
        this.data[index] = stage.slot;
        this.data[index + 1] = rotation;
        changed = true;
      }
    }
    if (this.data[offset] !== count) {
      this.data[offset] = count;
      changed = true;
    }
    if (requested > MAX_GOBO_STAGES) this.reduced.add(id);
    else this.reduced.delete(id);
    if (changed) this.texture.needsUpdate = true;
    return count ? -(row + 1) : 0;
  }

  /** Releases a removed emitter's row without invalidating addresses held by other emitters. */
  release(id: string): void {
    const row = this.slots.get(id);
    if (row === undefined) return;
    this.slots.delete(id);
    this.reduced.delete(id);
    this.free.push(row);
  }

  /** Clears active reduction diagnostics when an emitter is dark, retaining its prepared row. */
  deactivate(id: string): void {
    this.reduced.delete(id);
  }

  /** Releases scene-owned GPU storage. */
  dispose(): void {
    this.texture.dispose();
    this.slots.clear();
    this.reduced.clear();
    this.free.length = 0;
  }
}
