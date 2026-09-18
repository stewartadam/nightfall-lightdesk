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

/** Verifies numeric priority ordering follows the requested direction. */
test("status instance sorting orders numeric priorities", () => {
  const lower = instanceRow({ priority: 10 });
  const higher = instanceRow({ priority: 20 });
  const labels = {
    clipLabel: () => "Unbound",
    ownerLabels: () => "-",
  };

  assert.ok(
    compareStatusInstanceRows(lower, higher, "priority", "asc", labels) < 0,
  );
  assert.ok(
    compareStatusInstanceRows(lower, higher, "priority", "desc", labels) > 0,
  );
});

/** Verifies owner sorting uses the panel-projected operator labels. */
test("status instance sorting uses projected owner labels", () => {
  const left = instanceRow({ instance_id: "left" });
  const right = instanceRow({ instance_id: "right" });
  const labels = {
    clipLabel: () => "Unbound",
    ownerLabels: (row: StatusInstanceInfo) =>
      row.instance_id === "left" ? "Alpha" : "Zulu",
  };

  assert.ok(
    compareStatusInstanceRows(left, right, "owners", "asc", labels) < 0,
  );
});
