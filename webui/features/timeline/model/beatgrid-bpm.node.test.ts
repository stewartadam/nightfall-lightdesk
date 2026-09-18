// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBeatgridBpmInput } from "./beatgrid-bpm";

/** Verifies compact beatgrid BPM edits keep decimal tempo precision. */
test("parseBeatgridBpmInput preserves fractional tempos", () => {
  assert.equal(parseBeatgridBpmInput("128.5"), 128.5);
});

/** Verifies invalid beatgrid BPM edits do not produce persisted values. */
test("parseBeatgridBpmInput rejects non-finite tempo input", () => {
  assert.equal(parseBeatgridBpmInput("not bpm"), undefined);
  assert.equal(parseBeatgridBpmInput("Infinity"), undefined);
});
