// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types";
import {
  allFixturesTarget,
  buildSetMasterModeCommand,
  buildStoreMasterCommand,
  groupTarget,
  modeFromKey,
  modeKey,
  nextMasterId,
  targetLabel,
} from "./master-model";

const GROUP = {
  identifiers: { id: 7, uid: "group-uid", label: "Front Wash" },
} as types.Group;
const MASTER = {
  identifiers: { id: 3, uid: "master-uid", label: "House" },
} as types.Master;

/** Verifies master creation chooses the next ID and backend-tagged defaults. */
test("master creation model builds inhibitive always-on commands", () => {
  assert.equal(nextMasterId({ current: MASTER }), 4);
  assert.deepEqual(
    buildStoreMasterCommand(
      { current: MASTER },
      types.MasterKind.InhibitiveIntensity,
      allFixturesTarget(),
      "Global Master",
      "new-uid",
    ),
    {
      type: "StoreMaster",
      data: {
        identifiers: { id: 4, uid: "new-uid", label: "Global Master" },
        kind: types.MasterKind.InhibitiveIntensity,
        target: { type: "Fixtures", data: { type: "All" } },
        mode: { type: "AlwaysOn" },
        level_percent: 100,
      },
    },
  );
});

/** Verifies UI mode keys round-trip into master commands. */
test("master mode model round-trips toggle state", () => {
  assert.equal(modeKey(modeFromKey("toggle-on")), "toggle-on");
  assert.deepEqual(buildSetMasterModeCommand(3, "toggle-off"), {
    type: "SetMasterMode",
    data: { id: 3, mode: { type: "Toggle", data: { active: false } } },
  });
});

/** Verifies target labels resolve group identity and missing references. */
test("master target labels distinguish global, group, and missing targets", () => {
  assert.equal(targetLabel(allFixturesTarget(), {}, {}), "All fixtures");
  assert.equal(
    targetLabel(groupTarget("group-uid"), { "group-uid": GROUP }, {}),
    "Group 7: Front Wash",
  );
  assert.equal(targetLabel(groupTarget("missing"), {}, {}), "Missing group");
});
