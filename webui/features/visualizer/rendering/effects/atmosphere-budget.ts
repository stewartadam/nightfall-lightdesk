// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Completed GPU measurements; IDs prevent stale readbacks from counting as new evidence. */
export interface GpuBudgetSample {
  id: number;
  milliseconds: number;
}

const SCALES = [0.5, 0.375, 0.25] as const;

/** Bounds offscreen pixel cost with fast degradation and deliberately slow recovery. */
export class ResolutionBudget {
  private tier = 0;
  private lastSample = -1;
  private overloaded = 0;
  private underloaded = 0;
  private lastChange = -Infinity;

  /** Uses prepared quality tiers, ordered from highest resolution to the performance floor. */
  constructor(private readonly scales: readonly number[]) {}

  /** Returns the current linear resolution scale, independent of display pixel ratio. */
  get scale(): number {
    return this.scales[this.tier];
  }

  /** Consumes only fresh valid timings; missing timing never implies spare GPU capacity. */
  update(sample: GpuBudgetSample | undefined, now: number): number {
    if (
      !sample ||
      sample.id === this.lastSample ||
      !Number.isFinite(sample.milliseconds) ||
      sample.milliseconds < 0
    )
      return this.scale;
    this.lastSample = sample.id;
    this.overloaded = sample.milliseconds > 8 ? this.overloaded + 1 : 0;
    this.underloaded = sample.milliseconds < 4 ? this.underloaded + 1 : 0;
    if (now - this.lastChange < 1000) return this.scale;
    if (this.overloaded >= 3 && this.tier < this.scales.length - 1) {
      this.tier++;
    } else if (this.underloaded >= 120 && this.tier > 0) {
      this.tier--;
    } else {
      return this.scale;
    }
    this.lastChange = now;
    this.overloaded = 0;
    this.underloaded = 0;
    return this.scale;
  }
}

/** Starts fog at half resolution and reserves lower tiers for sustained overload. */
export class AtmosphereBudget extends ResolutionBudget {
  /** Configures the atmospheric pass's supported resolution tiers. */
  constructor() {
    super(SCALES);
  }
}
