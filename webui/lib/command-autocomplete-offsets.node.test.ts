// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  browserCommandOffsets,
  commandOffsetMap,
} from "./command-autocomplete-offsets";
import type { CommandAutocompleteResponse } from "./wasm-bridge";

/** Keeps cursor conversion on complete characters, including surrogate pairs and multibyte letters. */
test("command offsets round-trip Unicode boundaries and clamp interior positions", () => {
  const offsets = commandOffsetMap("aé😀z");
  const boundaries = [
    [0, 0],
    [1, 1],
    [2, 3],
    [4, 7],
    [5, 8],
  ];
  for (const [units, bytes] of boundaries) {
    assert.equal(offsets.toBytes(units), bytes);
    assert.equal(offsets.toCodeUnits(bytes), units);
  }
  assert.equal(offsets.toBytes(3), 3);
  assert.equal(offsets.toCodeUnits(2), 1);
  assert.equal(offsets.toCodeUnits(6), 2);
  assert.equal(offsets.toBytes(-1), 0);
  assert.equal(offsets.toCodeUnits(100), 5);
});

/** Translates global edits and segment-relative evidence independently after a Unicode statement. */
test("response offsets preserve Unicode edit ranges and local diagnostic spans", () => {
  const input = "é; 😀";
  const span = { start: 1, end: 5 };
  const replace = { start: 4, end: 8 };
  const response: CommandAutocompleteResponse = {
    input_len: 8,
    cursor: 8,
    segment_start: 3,
    segment_end: 8,
    replace,
    candidates: [
      {
        id: "c",
        expected: { kind: "literal", value: "fixture" },
        frontier_sources: [0],
        label: "fixture",
        insert_text: "fixture",
        apply_text: "fixture ",
        detail: null,
        replace,
        source: "grammar_token",
        completable: true,
      },
    ],
    object_reference_requests: [
      {
        id: "p",
        object_kind: "blueprint",
        slot: { slot: "address", clause: null },
        frontier_sources: [0],
        replace,
        query: "😀",
        before_value: "",
        after_value: " ",
      },
    ],
    parse: {
      status: "error",
      furthest_pos: 8,
      committed_clause_path: [],
      projected_clause_paths: [],
      frontier: {
        expected_rules: [],
        expected_tokens: [],
        alternatives: [
          {
            frontier_path: [],
            clause_path: [],
            replace: span,
            rule: "address",
            slot: null,
            next_clause: null,
            expected_tokens: [],
          },
        ],
      },
    },
    slot_plan: {
      loose_candidate_ids: ["c"],
      breadcrumb: { state: "none" },
      committed_path: [],
      active_slots: [],
      filled: [{ span }],
      completion_groups: [],
      loose_candidates: [],
      suppression: [{ because_of: { span } }],
      next_clause_options: [],
    },
  };
  const converted = browserCommandOffsets(input, response);
  const globalRange = { start: 3, end: 5 };
  const localRange = { start: 1, end: 3 };
  assert.equal(converted.input_len, 5);
  assert.equal(converted.cursor, 5);
  assert.equal(converted.segment_start, 2);
  assert.equal(converted.segment_end, 5);
  assert.equal(converted.parse.furthest_pos, 5);
  assert.deepEqual(converted.replace, globalRange);
  assert.deepEqual(converted.candidates[0].replace, globalRange);
  assert.deepEqual(converted.object_reference_requests[0].replace, globalRange);
  assert.deepEqual(
    converted.parse.frontier.alternatives[0].replace,
    localRange,
  );
  assert.deepEqual(converted.slot_plan.filled, [{ span: localRange }]);
  assert.deepEqual(converted.slot_plan.suppression, [
    { because_of: { span: localRange } },
  ]);
  assert.deepEqual(response.replace, replace);
  assert.equal(converted.object_reference_requests[0].query, "😀");
});
