// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as types from "../../../types";
import {
  describeReplacedMappings,
  formatBindConfirmation,
  formatReplacedNotice,
} from "./mapping-replacements";

/** Describes actions by a fixed label per action ID, standing in for the catalog. */
function describeAction(action: types.ActionReference): string {
  return (
    { "clip.go": "Clip X Go", "clip.stop": "Clip X Stop" }[action.id] ??
    action.id
  );
}

/** Treats every action as a trigger. */
function triggerKind(): types.ActionInputKind {
  return types.ActionInputKind.Trigger;
}

/** Builds a replaced mapping bound to an action with a behavior. */
function replaced(
  id: string,
  behavior: types.ControlBehavior = types.ControlBehavior.Press,
) {
  return { action: { id, arguments: {} }, behavior };
}

/** Verifies the bind confirmation names the replaced binding after the new one. */
test("formatBindConfirmation names the replaced binding", () => {
  assert.equal(
    formatBindConfirmation({
      control: "MIDI CC 7 ch 1 (Pad)",
      action: "Master A",
      behavior: "Follow fader",
      replaced: describeReplacedMappings(
        [replaced("clip.go")],
        describeAction,
        triggerKind,
      ),
    }),
    "Bound MIDI CC 7 ch 1 (Pad) → Master A · Follow fader (replaced: Clip X Go)",
  );
});

/** Verifies the confirmation is unchanged when nothing was replaced. */
test("formatBindConfirmation omits the suffix without replacements", () => {
  assert.equal(
    formatBindConfirmation({
      control: "OSC /fader/1",
      action: "Master A",
      behavior: "On press",
      replaced: [],
    }),
    "Bound OSC /fader/1 → Master A · On press",
  );
});

/** Verifies non-press replaced bindings carry their behavior so they can be told apart. */
test("describeReplacedMappings labels non-press behaviors", () => {
  assert.deepEqual(
    describeReplacedMappings(
      [
        replaced("clip.go"),
        replaced("clip.stop", types.ControlBehavior.Release),
      ],
      describeAction,
      triggerKind,
    ),
    ["Clip X Go", "Clip X Stop · On release"],
  );
});

/** Verifies the panel notice pluralizes by the number of replaced mappings. */
test("formatReplacedNotice pluralizes", () => {
  assert.equal(
    formatReplacedNotice(["Clip X Go"]),
    "Replaced mapping: Clip X Go",
  );
  assert.equal(
    formatReplacedNotice(["Clip X Go", "Clip X Stop"]),
    "Replaced mappings: Clip X Go, Clip X Stop",
  );
});
