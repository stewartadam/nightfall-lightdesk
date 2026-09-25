// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { AtmosphereBudget, TIMING_LOSS_RECOVERY_MS } from "./atmosphere-budget";

/** A stall or repeated readback must not trigger repeated target reallocations. */
test("atmospheric budget ignores stale samples and isolated spikes", () => {
  const budget = new AtmosphereBudget();
  for (let i = 0; i < 500; i++)
    budget.update({ id: 1, milliseconds: 30 }, i * 17);
  assert.equal(budget.scale, 0.5);
  budget.update({ id: 2, milliseconds: 2 }, 9000);
  budget.update({ id: 3, milliseconds: 30 }, 9017);
  assert.equal(budget.scale, 0.5);
  budget.update(undefined, 10000);
  budget.update({ id: 4, milliseconds: NaN }, 10001);
  assert.equal(budget.scale, 0.5);
});

/** A degraded tier must not persist forever once GPU timing stops arriving. */
test("atmospheric budget restores its default tier after timing is lost", () => {
  const budget = new AtmosphereBudget();
  for (let id = 0; id < 10; id++)
    budget.update({ id, milliseconds: 12 }, id * 1001);
  assert.equal(budget.scale, 0.25);
  const lastSampleAt = 9 * 1001;
  budget.update(undefined, lastSampleAt + TIMING_LOSS_RECOVERY_MS - 1);
  budget.update({ id: 9, milliseconds: 12 }, lastSampleAt + 1000);
  assert.equal(
    budget.scale,
    0.25,
    "brief gaps and stale samples keep the tier",
  );
  budget.update(undefined, lastSampleAt + TIMING_LOSS_RECOVERY_MS + 1);
  assert.equal(budget.scale, 0.5);
  for (let id = 10; id < 13; id++)
    budget.update(
      { id, milliseconds: 12 },
      lastSampleAt + TIMING_LOSS_RECOVERY_MS + 1001 + id,
    );
  assert.equal(budget.scale, 0.375, "returning timing resumes degradation");
});

/** Sustained overload reduces cost to a floor; recovery requires sustained headroom. */
test("atmospheric budget bounds cost and recovers with hysteresis", () => {
  const budget = new AtmosphereBudget();
  for (let id = 0; id < 10; id++)
    budget.update({ id, milliseconds: 12 }, id * 1001);
  assert.equal(budget.scale, 0.25);
  for (let id = 10; id < 129; id++)
    budget.update({ id, milliseconds: 2 }, 10000 + id * 17);
  assert.equal(budget.scale, 0.25);
  budget.update({ id: 129, milliseconds: 2 }, 13000);
  assert.equal(budget.scale, 0.375);
  budget.update({ id: 130, milliseconds: 12 }, 13017);
  assert.equal(budget.scale, 0.375);
});
