// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types";
import { recommendedBinding } from "./binding-behaviors";

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
