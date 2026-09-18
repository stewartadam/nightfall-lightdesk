// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseSimpleShowfileSaveCommand } from "./showfile-save-command-parser";

/** Verifies simple save inputs are recognized for layout-aware save commands. */
test("parseSimpleShowfileSaveCommand parses simple save commands", () => {
  assert.deepEqual(parseSimpleShowfileSaveCommand("save"), {});
  assert.deepEqual(parseSimpleShowfileSaveCommand("save tour"), {
    name: "tour",
  });
});

/** Verifies command batches keep the normal Eval parser path. */
test("parseSimpleShowfileSaveCommand ignores semicolon command batches", () => {
  assert.equal(parseSimpleShowfileSaveCommand("save tour;undo"), null);
  assert.equal(parseSimpleShowfileSaveCommand("save tour;"), null);
  assert.equal(parseSimpleShowfileSaveCommand("save;undo"), null);
});
