// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesShortcutSearch,
  type SearchableShortcut,
  shortcutSearchTerms,
} from "./shortcut-search";

const undo: SearchableShortcut = {
  description: "Undo",
  key: "$mod+z",
  groupLabel: "Global",
};

const stopPlayback: SearchableShortcut = {
  description: "Stop playback",
  key: "Escape",
  groupLabel: "Timeline",
};

/** Applies a typed query to one shortcut, on either platform. */
function matches(
  query: string,
  shortcut: SearchableShortcut,
  applePlatform = false,
): boolean {
  return matchesShortcutSearch(
    shortcutSearchTerms(query),
    shortcut,
    applePlatform,
  );
}

/** Verifies a blank or whitespace query keeps every shortcut listed. */
test("an empty query matches every shortcut", () => {
  assert.equal(matches("", undo), true);
  assert.equal(matches("   ", stopPlayback), true);
});

/** Verifies descriptions and group names match case-insensitively, with every word required. */
test("matches descriptions and group names word by word", () => {
  assert.equal(matches("UNDO", undo), true);
  assert.equal(matches("timeline stop", stopPlayback), true);
  assert.equal(matches("timeline undo", stopPlayback), false);
});

/** Verifies keys match by their cap names, with or without spaces around `+`. */
test("matches keys as the key caps name them", () => {
  assert.equal(matches("ctrl+z", undo), true);
  assert.equal(matches("ctrl + z", undo), true);
  assert.equal(matches("command+z", undo, true), true);
  assert.equal(matches("cmd+z", undo, true), true);
  assert.equal(matches("ctrl+z", undo, true), false);
  assert.equal(matches("esc", stopPlayback), true);
  assert.equal(matches("escape", stopPlayback), true);
});
