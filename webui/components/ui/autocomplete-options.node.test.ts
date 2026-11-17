// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { filterAutocompleteOptions } from "./autocomplete-options";

const OPTIONS = [
  { value: "ColorAdd_R", description: "Color · Red" },
  { value: "Dimmer", description: "Dimmer · Dimmer" },
  { value: "Pan", description: "Position · Pan" },
  { value: "Shutter1", description: "Shutter · Shutter" },
];

/** Blank text suggests every option in the caller's order. */
test("filterAutocompleteOptions keeps every option for blank text", () => {
  assert.deepEqual(filterAutocompleteOptions(OPTIONS, "  "), OPTIONS);
});

/** Typed words match the description too, so "red" finds the red emitter. */
test("filterAutocompleteOptions matches descriptions", () => {
  assert.deepEqual(
    filterAutocompleteOptions(OPTIONS, "red").map((option) => option.value),
    ["ColorAdd_R"],
  );
});

/** Values that start with the typed text lead, ahead of values that only contain it. */
test("filterAutocompleteOptions ranks values starting with the text first", () => {
  assert.deepEqual(
    filterAutocompleteOptions(OPTIONS, "sh").map((option) => option.value),
    ["Shutter1"],
  );
  assert.deepEqual(
    filterAutocompleteOptions(
      [{ value: "ColorAdd_R" }, { value: "Color" }, { value: "MyColor" }],
      "color",
    ).map((option) => option.value),
    ["ColorAdd_R", "Color", "MyColor"],
  );
  assert.deepEqual(
    filterAutocompleteOptions(
      [{ value: "MyPan" }, { value: "Pan" }],
      "pan",
    ).map((option) => option.value),
    ["Pan", "MyPan"],
  );
});
