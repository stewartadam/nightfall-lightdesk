// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { decodeTapPatternState } from "./tap-pattern-state";

/** Verifies persisted tap state is sorted, renumbered, and option values are clamped. */
test("tap pattern persistence sanitizes restored capture state", () => {
  assert.deepEqual(
    decodeTapPatternState(
      JSON.stringify({
        taps: [
          { id: 99, timeMs: 300, key: "b" },
          { id: 42, timeMs: 100, key: "a" },
          { id: 7, timeMs: -1 },
        ],
        detectionOptions: { sensitivity: 200, granularity: -20 },
      }),
    ),
    {
      taps: [
        { id: 1, timeMs: 100, key: "a" },
        { id: 2, timeMs: 300, key: "b" },
      ],
      detectionOptions: { sensitivity: 100, granularity: 0 },
    },
  );
});

/** Verifies malformed persisted JSON falls back to an empty default capture. */
test("tap pattern persistence rejects malformed JSON", () => {
  assert.deepEqual(decodeTapPatternState("{"), {
    taps: [],
    detectionOptions: { sensitivity: 50, granularity: 50 },
  });
});
