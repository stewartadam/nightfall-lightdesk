// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { highlightSegments } from "./highlighted-text-segments";

/** Verifies text without search words stays one plain run. */
test("no terms leave the text unmarked", () => {
  assert.deepEqual(highlightSegments("Undo", []), [
    { text: "Undo", match: false },
  ]);
});

/** Verifies matches ignore case, keep the original casing and find every occurrence. */
test("marks every case-insensitive occurrence", () => {
  assert.deepEqual(highlightSegments("Delete selected clips", ["sel", "e"]), [
    { text: "D", match: false },
    { text: "e", match: true },
    { text: "l", match: false },
    { text: "e", match: true },
    { text: "t", match: false },
    { text: "e", match: true },
    { text: " ", match: false },
    { text: "sele", match: true },
    { text: "ct", match: false },
    { text: "e", match: true },
    { text: "d clips", match: false },
  ]);
});

/** Verifies overlapping terms merge into one marked run. */
test("merges overlapping matches", () => {
  assert.deepEqual(
    highlightSegments("Switch to layout 10", ["lay", "layout"]),
    [
      { text: "Switch to ", match: false },
      { text: "layout", match: true },
      { text: " 10", match: false },
    ],
  );
});
