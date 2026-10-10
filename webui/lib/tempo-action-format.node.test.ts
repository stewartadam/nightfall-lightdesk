// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatTempoAction, parseTempoAction } from "./tempo-action-format";

/** Verifies every tempo action text form round-trips through parse and format. */
test("tempo actions round-trip through mapping text", () => {
  for (const text of [
    "TapTempo",
    "ResyncTempo",
    "SetTempo(128)",
    "MultiplyTempo(0.5)",
    "NudgeTempo(-0.1)",
  ]) {
    const action = parseTempoAction(text);
    assert.ok(action, text);
    assert.equal(formatTempoAction(action), text);
  }
});

/** Verifies parsed actions carry the registered IDs and argument keys. */
test("parseTempoAction builds registered action references", () => {
  assert.deepEqual(parseTempoAction("SetTempo(128.5)"), {
    id: "tempo.set",
    arguments: { bpm: 128.5 },
  });
  assert.deepEqual(parseTempoAction(" TapTempo "), {
    id: "tempo.tap",
    arguments: {},
  });
});

/** Verifies non-tempo text and actions are left for other formatters. */
test("tempo formatting ignores other actions", () => {
  assert.equal(parseTempoAction("StartClip(1)"), undefined);
  assert.equal(parseTempoAction("SetTempo()"), undefined);
  assert.equal(
    formatTempoAction({ id: "clip.start", arguments: {} }),
    undefined,
  );
});

/** Verifies tempos and multipliers must be positive, while nudges may go either way. */
test("parseTempoAction rejects non-positive tempos and multipliers", () => {
  assert.equal(parseTempoAction("SetTempo(0)"), undefined);
  assert.equal(parseTempoAction("MultiplyTempo(-2)"), undefined);
  assert.ok(parseTempoAction("NudgeTempo(-0.25)"));
});

/** Verifies tiny or long arguments format as decimals the parser reads back. */
test("formatTempoAction never emits exponent notation", () => {
  assert.equal(
    formatTempoAction({ id: "tempo.nudge", arguments: { beats: 1e-7 } }),
    "NudgeTempo(0)",
  );
  assert.equal(
    formatTempoAction({ id: "tempo.set", arguments: { bpm: 1 / 3 } }),
    "SetTempo(0.333333)",
  );
});
