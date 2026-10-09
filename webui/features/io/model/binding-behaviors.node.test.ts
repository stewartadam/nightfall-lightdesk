// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GridCellKind } from "../../../lib/data-grid-types";
import * as types from "../../../types";
import {
  behaviorCell,
  editedBehavior,
  recommendedBinding,
} from "./binding-behaviors";

const { Press, Release, Hold, Flash } = types.ControlBehavior;
const { Absolute, Trigger } = types.ActionInputKind;

/** Options a master offers: its level, and a toggle bound on press, release, or hold. */
const masterOptions = [
  { label: "Level", behavior: Press, inputKind: Absolute },
  { label: "Level", behavior: Flash, inputKind: Absolute },
  { label: "Toggle", behavior: Press, inputKind: Trigger },
  { label: "Toggle", behavior: Release, inputKind: Trigger },
  { label: "Toggle", behavior: Hold, inputKind: Trigger },
];

/** Verifies a fader is suggested to follow the level and a button to toggle on press. */
test("recommendedBinding follows faders and presses buttons", () => {
  assert.deepEqual(recommendedBinding(masterOptions, true), masterOptions[0]);
  assert.deepEqual(recommendedBinding(masterOptions, false), masterOptions[2]);
});

/** Verifies the suggestion falls back to any press, then to the first option. */
test("recommendedBinding falls back when the preferred kind is missing", () => {
  const triggerOnly = [
    { behavior: Release, inputKind: Trigger },
    { behavior: Press, inputKind: Trigger },
  ];
  assert.deepEqual(recommendedBinding(triggerOnly, true), triggerOnly[1]);

  const releaseOnly = [{ behavior: Release, inputKind: Trigger }];
  assert.deepEqual(recommendedBinding(releaseOnly, false), releaseOnly[0]);
  assert.equal(recommendedBinding([], false), undefined);
});

/** Builds a catalog entry for a trigger action that supports the given behaviors. */
function triggerEntry(
  behaviors: types.ControlBehavior[],
): types.ActionCatalogEntry {
  return {
    descriptor: { input: Trigger },
    behaviors,
  } as unknown as types.ActionCatalogEntry;
}

/**
 * Verifies the Behavior dropdown offers the action's behaviors with popover labels, keeps a
 * stored behavior the action no longer supports, and reads a chosen behavior back.
 */
test("behaviorCell offers supported behaviors and editedBehavior reads the choice", () => {
  const cell = behaviorCell(Press, triggerEntry([Press, Release, Hold]));
  assert.deepEqual(cell.data.allowedValues, [
    { value: Press, label: "On press" },
    { value: Release, label: "On release" },
    { value: Hold, label: "While held" },
  ]);
  assert.equal(cell.copyData, Press);

  const stale = behaviorCell(Flash, triggerEntry([Press]));
  assert.deepEqual(stale.data.allowedValues, [
    { value: Flash, label: "Flash to full" },
    { value: Press, label: "On press" },
  ]);

  assert.equal(
    editedBehavior({ ...cell, data: { ...cell.data, value: Hold } }),
    Hold,
  );
  assert.equal(
    editedBehavior({ ...cell, data: { ...cell.data, value: "Sometimes" } }),
    undefined,
  );
  assert.equal(
    editedBehavior({
      kind: GridCellKind.Text,
      data: "Hold",
      displayData: "Hold",
      allowOverlay: true,
    }),
    undefined,
  );
});
