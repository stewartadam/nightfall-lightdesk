// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesSearchTerms,
  renderedText,
  searchTerms,
  unmatchedSearchTerms,
} from "./search-match";

/** Verifies queries split into lowercased words and ignore surrounding or repeated spaces. */
test("searchTerms splits and lowercases the query", () => {
  assert.deepEqual(searchTerms("  DMX   Rate "), ["dmx", "rate"]);
  assert.deepEqual(searchTerms("   "), []);
});

/** Verifies every word must appear, in any order and across any of the texts, and blanks are skipped. */
test("matchesSearchTerms requires every word somewhere in the texts", () => {
  const texts = ["DMX output rate (Hz)", undefined, "Art-Net and sACN packets"];
  assert.ok(matchesSearchTerms(["rate", "dmx"], texts));
  assert.ok(matchesSearchTerms(["sacn", "output"], texts));
  assert.ok(!matchesSearchTerms(["dmx", "audio"], texts));
  assert.ok(matchesSearchTerms([], texts));
});

/** Verifies only the words missing from the texts are returned, so a heading can pass the rest down. */
test("unmatchedSearchTerms returns the words the texts lack", () => {
  assert.deepEqual(
    unmatchedSearchTerms(["visualizer", "quality"], ["Visualizer"]),
    ["quality"],
  );
  assert.deepEqual(unmatchedSearchTerms(["quality"], ["Quality preset"]), []);
});

/** Verifies plain values and nested arrays flatten to their text, and empty values contribute nothing. */
test("renderedText flattens rendered values to text", () => {
  assert.equal(renderedText("Beat model"), "Beat model");
  assert.equal(renderedText(["Size", 12, null, false]), "Size 12  ");
  assert.equal(renderedText(undefined), "");
});
