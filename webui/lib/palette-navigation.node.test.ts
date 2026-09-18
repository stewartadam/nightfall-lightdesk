// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { nextPaletteIndex } from "./palette-navigation";

test("nextPaletteIndex wraps arrow navigation and clamps page navigation", () => {
  assert.equal(nextPaletteIndex(2, 5, "ArrowDown", 3), 3);
  assert.equal(nextPaletteIndex(0, 5, "ArrowUp", 3), 4);
  assert.equal(nextPaletteIndex(1, 5, "PageDown", 3), 4);
  assert.equal(nextPaletteIndex(4, 5, "PageDown", 3), 4);
  assert.equal(nextPaletteIndex(3, 5, "PageUp", 3), 0);
  assert.equal(nextPaletteIndex(0, 5, "PageUp", 3), 0);
});
