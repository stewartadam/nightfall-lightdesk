// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatMidiAction, parseMidiAction } from "./model/action-format";

test("parseAction supports SetControl mappings", () => {
  assert.deepEqual(parseMidiAction("SetControl(4)"), {
    id: "control.set-external",
    arguments: { control_index: 4 },
  });
});

test("formatAction renders SetControl mappings", () => {
  assert.equal(
    formatMidiAction({
      id: "control.set-external",
      arguments: { control_index: 7 },
    }),
    "SetControl(7)",
  );
});
