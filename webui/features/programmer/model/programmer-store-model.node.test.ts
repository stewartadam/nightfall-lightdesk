// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../../../types";
import {
  buildCueTargetOptions,
  buildGroupTargetOptions,
  buildStoreCueCommand,
  buildStoreGroupCommand,
  cueDialogDefaults,
  nextAvailableGroupId,
} from "./programmer-store-model";

const CUE = {
  identifiers: { id: 2, uid: "cue-uid", label: "Warm" },
} as types.Cue;
const SEQUENCE = {
  identifiers: { id: 4, uid: "sequence-uid", label: "Main" },
  steps: ["cue-uid", "cue-uid"],
} as types.Sequence;
const GROUP = {
  identifiers: { id: 7, uid: "group-uid", label: "Back" },
} as types.Group;

/** Verifies cue targets are sorted and deduplicated by operator-facing identity. */
test("programmer cue targets project sequence membership once", () => {
  assert.deepEqual(
    buildCueTargetOptions({ "cue-uid": CUE }, { sequence: SEQUENCE }),
    [
      {
        key: "4.2",
        sequenceId: 4,
        cueId: 2,
        cueLabel: "Warm",
        sequenceLabel: "Main",
      },
    ],
  );
});

/** Verifies store-dialog defaults advance IDs within their owning scope. */
test("programmer store dialog defaults advance cue and group IDs", () => {
  const cueTargets = buildCueTargetOptions(
    { "cue-uid": CUE },
    { sequence: SEQUENCE },
  );
  assert.deepEqual(cueDialogDefaults({ sequence: SEQUENCE }, cueTargets), {
    sequenceId: 4,
    cueId: 3,
    label: "Cue 3",
  });
  const groupTargets = buildGroupTargetOptions({ group: GROUP });
  assert.equal(nextAvailableGroupId(groupTargets), 8);
});

/** Verifies store commands normalize IDs and blank labels. */
test("programmer store commands normalize dialog input", () => {
  assert.deepEqual(buildStoreCueCommand(0, 0, ""), {
    type: "StoreCue",
    data: {
      sequence_id: 1,
      cue_id: { type: "Exact", data: 1 },
      part_id: { type: "Exact", data: 0 },
      mode: "replace",
      label: "Cue 1",
    },
  });
  assert.deepEqual(buildStoreGroupCommand(0, "  "), {
    type: "StoreGroup",
    data: { group_id: 1, label: undefined },
  });
});
