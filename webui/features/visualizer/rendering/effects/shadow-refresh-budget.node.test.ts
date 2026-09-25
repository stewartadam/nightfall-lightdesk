// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ShadowRefreshBudget } from "./shadow-refresh-budget";

/** Optional refreshes require sustained GPU capacity and include DMX work in the CPU budget. */
test("shadow refreshes require fresh measurements and spare CPU and GPU capacity", () => {
  const budget = new ShadowRefreshBudget();
  assert.equal(budget.canRefresh(undefined, 0), false);
  assert.equal(budget.canRefresh({ id: 1, milliseconds: 3 }, 0), false);
  budget.recordRender(4);
  assert.equal(budget.canRefresh({ id: 2, milliseconds: 3 }, 2), false);
  assert.equal(budget.canRefresh({ id: 3, milliseconds: 3 }, 2), true);
  assert.equal(budget.canRefresh({ id: 3, milliseconds: 3 }, 2), false);
  assert.equal(budget.canRefresh({ id: 4, milliseconds: 3 }, 4), false);
  assert.equal(budget.canRefresh({ id: 5, milliseconds: 8 }, 0), false);
  assert.equal(budget.canRefresh({ id: 6, milliseconds: 3 }, 0), false);
  assert.equal(budget.canRefresh({ id: 7, milliseconds: 3 }, 0), false);
  assert.equal(budget.canRefresh({ id: 8, milliseconds: 3 }, 0), true);
  budget.recordRender(10);
  assert.equal(budget.canRefresh({ id: 9, milliseconds: 3 }, 0), false);
});

/** Invalid instrumentation must fail closed instead of being mistaken for idle hardware. */
test("invalid timing never enables a shadow refresh", () => {
  for (const invalid of [NaN, Infinity, -1]) {
    const budget = new ShadowRefreshBudget();
    budget.recordRender(1);
    for (let id = 0; id < 3; id++)
      budget.canRefresh({ id, milliseconds: 1 }, 0);
    assert.equal(budget.canRefresh({ id: 3, milliseconds: invalid }, 0), false);
    assert.equal(budget.canRefresh({ id: 4, milliseconds: 1 }, 0), false);
    budget.canRefresh({ id: 5, milliseconds: 1 }, 0);
    assert.equal(budget.canRefresh({ id: 6, milliseconds: 1 }, invalid), false);
    budget.recordRender(invalid);
    assert.equal(budget.canRefresh({ id: 7, milliseconds: 1 }, 0), false);
  }
});
