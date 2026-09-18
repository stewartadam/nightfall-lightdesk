// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Sequence } from "../../../types";
import {
  normalizeSequenceUid,
  sortSequencesForDisplay,
} from "./sequence-list-model";

/** Builds the sequence fields consumed by sequence-list projection tests. */
function sequence(uid: string, id: number): Sequence {
  return { identifiers: { uid, id, label: `Sequence ${id}` } } as Sequence;
}

/** Verifies sequence display order is numeric and does not mutate store input. */
test("sorts sequences for display without mutating input", () => {
  const input = [sequence("B", 9), sequence("A", 2)];
  const result = sortSequencesForDisplay(input);
  assert.deepEqual(
    result.map((entry) => entry.identifiers.id),
    [2, 9],
  );
  assert.deepEqual(
    input.map((entry) => entry.identifiers.id),
    [9, 2],
  );
});

/** Verifies mixed sequence UID inputs normalize to matching DOM identifiers. */
test("normalizes sequence UIDs", () => {
  assert.equal(normalizeSequenceUid("ABC123"), "abc123");
  assert.equal(normalizeSequenceUid(42), "42");
});
