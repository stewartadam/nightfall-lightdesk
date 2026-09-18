// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isColorPathDrivenAttribute,
  isColorPathVectorAttribute,
} from "./color-path-driven-attributes";

/** Verifies runtime-supported primary and auxiliary emitters are recognized as color path outputs. */
test("isColorPathVectorAttribute recognizes color path output emitters", () => {
  for (const attribute of [
    "Red",
    "Green",
    "Blue",
    "White",
    "Amber",
    "WarmWhite",
    "CoolWhite",
    "UV",
    "Cyan",
    "Magenta",
    "Yellow",
  ]) {
    assert.equal(isColorPathVectorAttribute(attribute), true, attribute);
  }
});

/** Verifies non-color attributes are not marked as color path-derived cells. */
test("isColorPathVectorAttribute rejects unsupported emitter attributes", () => {
  for (const attribute of ["Intensity", "VirtualIntensity"]) {
    assert.equal(isColorPathVectorAttribute(attribute), false, attribute);
  }
});

/** Verifies cue cells require an assigned color path before they are path-driven. */
test("isColorPathDrivenAttribute requires a color path assignment", () => {
  assert.equal(isColorPathDrivenAttribute(undefined, "Cyan"), false);
  assert.equal(isColorPathDrivenAttribute(3, "Cyan"), true);
  assert.equal(isColorPathDrivenAttribute(3, "Intensity"), false);
});
