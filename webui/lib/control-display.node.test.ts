// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowDisparateControlValues } from "./control-display";

test("shows split values when hardware and console meaningfully differ", () => {
  assert.equal(shouldShowDisparateControlValues(10, 80), true);
});

test("hides split values when hardware and console are effectively equal", () => {
  assert.equal(shouldShowDisparateControlValues(49.8, 50), false);
});
