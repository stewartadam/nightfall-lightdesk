// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GpuBudgetSample } from "./atmosphere-budget";

/** Admits optional map refreshes only after sustained GPU headroom and a bounded CPU submission. */
export class ShadowRefreshBudget {
  private lastSample = -1;
  private spareSamples = 0;
  private renderMs = Infinity;

  /** Records the whole rendering submission, including any shadow work performed. */
  recordRender(milliseconds: number): void {
    this.renderMs = milliseconds;
  }

  /** Consumes each completed measurement once; missing, invalid, or overloaded data never grants work. */
  canRefresh(sample: GpuBudgetSample | undefined, updateMs: number): boolean {
    if (!sample || sample.id === this.lastSample) return false;
    this.lastSample = sample.id;
    if (
      !Number.isFinite(sample.milliseconds) ||
      sample.milliseconds < 0 ||
      sample.milliseconds >= 6
    ) {
      this.spareSamples = 0;
      return false;
    }
    this.spareSamples = Math.min(3, this.spareSamples + 1);
    return (
      this.spareSamples === 3 &&
      Number.isFinite(updateMs) &&
      updateMs >= 0 &&
      Number.isFinite(this.renderMs) &&
      this.renderMs >= 0 &&
      this.renderMs + updateMs < 8
    );
  }
}
