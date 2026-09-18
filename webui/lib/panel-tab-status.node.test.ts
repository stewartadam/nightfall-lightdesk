// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getPanelTabStatus,
  registerPanelTabStatus,
  subscribePanelTabStatus,
} from "./panel-tab-status";

/** Verifies subscribers receive initial, active, restored, and disposed status. */
test("panel tab status follows one publisher lifecycle", () => {
  const observed: Array<string | undefined> = [];
  const unsubscribe = subscribePanelTabStatus("panel-a", (status) =>
    observed.push(status),
  );
  const registration = registerPanelTabStatus("panel-a");

  registration.setStatus("saving");
  registration.setStatus(undefined);
  registration.setStatus("saving");
  registration.dispose();
  unsubscribe();

  assert.deepEqual(observed, [
    undefined,
    "saving",
    undefined,
    "saving",
    undefined,
  ]);
  assert.equal(getPanelTabStatus("panel-a"), undefined);
});

/** Verifies stale cleanup cannot clear another mounted owner's saving state. */
test("panel tab status aggregates overlapping panel registrations", () => {
  const first = registerPanelTabStatus("panel-b");
  const second = registerPanelTabStatus("panel-b");

  first.setStatus("saving");
  second.setStatus("saving");
  first.dispose();
  assert.equal(getPanelTabStatus("panel-b"), "saving");

  second.dispose();
  assert.equal(getPanelTabStatus("panel-b"), undefined);
});
