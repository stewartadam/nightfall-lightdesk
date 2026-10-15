// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  compareStatusInstanceRows,
  type StatusInstanceInfo,
} from "./instance-status-model";

/** Creates the instance fields required by status-table sorting tests. */
function instanceRow(
  overrides: Partial<StatusInstanceInfo>,
): StatusInstanceInfo {
  return {
    display_kind: "Cue",
    intensity_scale: 1,
    name: "Instance",
    rate: 1,
    tags: [],
    ...overrides,
  } as StatusInstanceInfo;
}

/** Verifies the default order puts the highest priority first and unprioritized rows last. */
test("status instance default order ranks higher priorities first", () => {
  const lower = instanceRow({ priority: 10, name: "Lower" });
  const higher = instanceRow({ priority: 20, name: "Higher" });
  const unprioritized = instanceRow({ name: "Unprioritized" });

  assert.deepEqual(
    [unprioritized, lower, higher]
      .sort(compareStatusInstanceRows)
      .map((row) => row.name),
    ["Higher", "Lower", "Unprioritized"],
  );
});

/** Verifies equal priorities fall back to activation order, then kind and name. */
test("status instance default order breaks ties by activation, kind and name", () => {
  const newer = instanceRow({ activation_epoch_ms: 20, name: "Newer" });
  const older = instanceRow({ activation_epoch_ms: 10, name: "Older" });
  const fx = instanceRow({ display_kind: "Fx", name: "Alpha" } as never);
  const cueZulu = instanceRow({ name: "Zulu" });
  const cueAlpha = instanceRow({ name: "Alpha" });

  assert.deepEqual(
    [newer, older].sort(compareStatusInstanceRows).map((row) => row.name),
    ["Older", "Newer"],
  );
  assert.deepEqual(
    [fx, cueZulu, cueAlpha]
      .sort(compareStatusInstanceRows)
      .map((row) => `${row.display_kind} ${row.name}`),
    ["Cue Alpha", "Cue Zulu", "Fx Alpha"],
  );
});
