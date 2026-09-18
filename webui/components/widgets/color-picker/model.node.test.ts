// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  colorPickerValue,
  colorStringToHsv,
  hsvColorsEqual,
  hsvToRgb,
  rgbToHex,
} from "./model";

/** Verifies primary HSV colors convert to the expected integer sRGB channels. */
test("hsvToRgb converts normalized primary colors", () => {
  assert.deepEqual(hsvToRgb({ h: 0, s: 1, v: 1 }), [255, 0, 0]);
  assert.deepEqual(hsvToRgb({ h: 120, s: 1, v: 1 }), [0, 255, 0]);
});

/** Verifies RGB formatting clamps channels and produces a stable uppercase value. */
test("rgbToHex formats clamped uppercase colors", () => {
  assert.equal(rgbToHex(255, 127, 0), "#FF7F00");
  assert.equal(rgbToHex(300, -10, 16), "#FF0010");
});

/** Verifies CSS colors convert to HSV and round-trip through the picker value. */
test("color strings round-trip through picker values", () => {
  const hsv = colorStringToHsv("#00FFFF");
  assert.equal(colorPickerValue(hsv).hex, "#00FFFF");
  assert.equal(hsvColorsEqual(hsv, { h: 180, s: 1, v: 1 }), true);
});
