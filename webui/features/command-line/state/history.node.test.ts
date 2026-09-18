// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { decodeCommandHistory } from "./history";

/** Verifies persisted history accepts only string command entries. */
test("decodeCommandHistory filters malformed persisted entries", () => {
  assert.deepEqual(decodeCommandHistory('["fixture 1", 3, null, "clear"]'), [
    "fixture 1",
    "clear",
  ]);
  assert.deepEqual(decodeCommandHistory("not-json"), []);
});
