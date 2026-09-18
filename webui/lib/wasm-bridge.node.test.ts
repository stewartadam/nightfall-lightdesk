// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import { projectSequenceLookahead } from "./wasm-bridge";

/** Builds a whole-fixture reference with a stable UID. */
function fixtureRef(fixtureUid: string): types.FixtureRef {
  return { fixture_uid: fixtureUid };
}

/** Builds an absolute value source for projection bridge tests. */
function absoluteSource(value: number): types.ValueSource {
  return {
    type: "Inline",
    data: { type: "Absolute", data: { value } },
  };
}

/** Verifies the web wrapper reaches the shared Rust lookahead projector. */
test("projectSequenceLookahead projects authored sequence lookahead values", async () => {
  const fixture = fixtureRef("00000000-0000-0000-0000-000000000001");

  const values = await projectSequenceLookahead({
    sequence_id: 9,
    wrap: false,
    target_cue_uid: "cue-1",
    setup_instructions: [],
    cues: [
      {
        cue_uid: "cue-1",
        cue_id: 1,
        lookahead: false,
        instructions: [
          {
            fixtures: [fixture],
            values: { Intensity: absoluteSource(0) },
          },
        ],
        parts: [],
      },
      {
        cue_uid: "cue-2",
        cue_id: 2,
        lookahead: true,
        instructions: [
          {
            fixtures: [fixture],
            values: { Pan: absoluteSource(90) },
          },
        ],
        parts: [],
      },
    ],
  });

  assert.deepEqual(values, [
    {
      fixture: {
        fixture_uid: "00000000000000000000000000000001",
        index: undefined,
      },
      attribute: "Pan",
      value: { type: "Absolute", data: { value: 90 } },
      source: {
        cue_uid: "cue-2",
        cue_id: 2,
        sequence_id: 9,
        part_id: 0,
        has_additional_parts: false,
      },
    },
  ]);
});
