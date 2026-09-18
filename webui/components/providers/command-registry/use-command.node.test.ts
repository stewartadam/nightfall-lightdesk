// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getCommandShortcutKeys } from "./command-types";

/** Verifies command shortcut aliases preserve the primary binding and add alternates. */
test("command shortcut keys include primary shortcut and aliases", () => {
  assert.deepEqual(
    getCommandShortcutKeys({
      id: "close-panel",
      name: "Close Panel",
      shortcut: "$mod+k w",
      shortcutAliases: ["$mod+w"],
      execute: () => {},
    }),
    ["$mod+k w", "$mod+w"],
  );
});

/** Verifies duplicate command shortcuts do not register colliding handlers. */
test("command shortcut keys remove duplicate aliases", () => {
  assert.deepEqual(
    getCommandShortcutKeys({
      id: "close-panel",
      name: "Close Panel",
      shortcut: "$mod+k w",
      shortcutAliases: ["$mod+k w", "$mod+w", "$mod+w"],
      execute: () => {},
    }),
    ["$mod+k w", "$mod+w"],
  );
});
