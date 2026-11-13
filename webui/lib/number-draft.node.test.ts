// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  formatNumberDraft,
  isWholeNumberInRange,
  parseNumberDraft,
  readNumberField,
} from "./number-draft";

/** Verifies blank text reads as null and anything else keeps the typed number, even out of range. */
test("parseNumberDraft keeps what was typed", () => {
  assert.equal(parseNumberDraft(""), null);
  assert.equal(parseNumberDraft("  "), null);
  assert.equal(parseNumberDraft("600"), 600);
  assert.equal(parseNumberDraft("1.5"), 1.5);
  assert.ok(Number.isNaN(parseNumberDraft("abc")));
});

/** Verifies unfinished text the browser can't parse reads as invalid rather than as a cleared field. */
test("readNumberField tells unfinished input from a blank field", () => {
  assert.equal(
    readNumberField({ value: "", validity: { badInput: false } }),
    null,
  );
  assert.ok(
    Number.isNaN(readNumberField({ value: "", validity: { badInput: true } })),
  );
  assert.equal(
    readNumberField({ value: "25", validity: { badInput: false } }),
    25,
  );
});

/** Verifies stored drafts format back to field text, with null and NaN shown blank. */
test("formatNumberDraft shows blank for missing or unparseable drafts", () => {
  assert.equal(formatNumberDraft(null), "");
  assert.equal(formatNumberDraft(Number.NaN), "");
  assert.equal(formatNumberDraft(600), "600");
});

/** Verifies only whole numbers inside the inclusive bounds are accepted. */
test("isWholeNumberInRange accepts whole numbers within bounds", () => {
  assert.equal(isWholeNumberInRange(1, 1, 512), true);
  assert.equal(isWholeNumberInRange(512, 1, 512), true);
  assert.equal(isWholeNumberInRange(600, 1, 512), false);
  assert.equal(isWholeNumberInRange(0, 1), false);
  assert.equal(isWholeNumberInRange(1.5, 1), false);
  assert.equal(isWholeNumberInRange(Number.NaN, 1), false);
  assert.equal(isWholeNumberInRange(null, 1), false);
  assert.equal(isWholeNumberInRange(1_000_000, 1), true);
});
