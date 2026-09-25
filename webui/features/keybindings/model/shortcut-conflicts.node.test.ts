// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type BuiltInShortcutInfo,
  builtInShortcutMatchesKey,
  decodeDisabledBuiltInShortcuts,
  findKeybindingConflicts,
  type KeybindingLike,
  uniqueBuiltInShortcuts,
  withBuiltInShortcutDisabled,
  withBuiltInShortcutEnabled,
} from "./shortcut-conflicts";

const UNDO: BuiltInShortcutInfo = { key: "Control+z", description: "Undo" };
const HELP: BuiltInShortcutInfo = {
  key: "Shift+?",
  description: "Show shortcuts",
};
const CONSOLE: BuiltInShortcutInfo = {
  key: "Shift+`",
  description: "Open Console",
};
const SEQUENCE: BuiltInShortcutInfo = {
  key: "g p",
  description: "Go to programmer",
};

/** Builds a user keybinding to a UI action for conflict tests. */
function binding(id: string, key: string): KeybindingLike {
  return { id, key, action: { id: `ui.${id}`, arguments: {} } };
}

/** Verifies recorded keys match built-ins written with letters, codes, and shifted symbols. */
test("builtInShortcutMatchesKey matches recorded keys against built-in syntax", () => {
  assert.equal(builtInShortcutMatchesKey("Control+z", "Control+KeyZ"), true);
  assert.equal(builtInShortcutMatchesKey("Control+KeyZ", "Control+KeyZ"), true);
  assert.equal(
    builtInShortcutMatchesKey("Control+z", "Control+Shift+KeyZ"),
    false,
  );
  assert.equal(builtInShortcutMatchesKey("Shift+?", "Shift+?"), true);
  assert.equal(builtInShortcutMatchesKey("Shift+/", "Shift+?"), true);
  assert.equal(builtInShortcutMatchesKey("Shift+`", "Shift+~"), true);
  assert.equal(builtInShortcutMatchesKey("Space", "Space"), true);
  assert.equal(builtInShortcutMatchesKey(" ", "Space"), true);
  assert.equal(builtInShortcutMatchesKey("Alt+1", "Alt+Digit1"), true);
  assert.equal(builtInShortcutMatchesKey("Enter", "Enter"), true);
});

/** Verifies multi-press sequences never conflict with a single-press keybinding. */
test("builtInShortcutMatchesKey ignores key sequences", () => {
  assert.equal(builtInShortcutMatchesKey("g p", "KeyG"), false);
  assert.equal(builtInShortcutMatchesKey("g p", "KeyP"), false);
});

/** Verifies conflicts list the shadowed built-in and replaced keybindings, but not the edited one. */
test("findKeybindingConflicts reports built-ins and other keybindings on the key", () => {
  const bindings = [
    binding("a", "Control+KeyZ"),
    binding("b", "Alt+KeyM"),
    binding("c", "Control+KeyZ"),
  ];
  const conflicts = findKeybindingConflicts(
    "Control+KeyZ",
    [UNDO, HELP, SEQUENCE],
    bindings,
    [],
    "c",
  );
  assert.deepEqual(conflicts, [
    { kind: "built-in", shortcut: UNDO },
    { kind: "keybinding", binding: bindings[0] },
  ]);
  assert.deepEqual(
    findKeybindingConflicts("Alt+KeyQ", [UNDO], bindings, []),
    [],
  );
});

/** Verifies a disabled built-in no longer counts as a conflict. */
test("findKeybindingConflicts skips disabled built-ins", () => {
  const disabled = withBuiltInShortcutDisabled([], UNDO);
  assert.deepEqual(
    findKeybindingConflicts("Control+KeyZ", [UNDO, CONSOLE], [], disabled),
    [],
  );
});

/** Verifies the same built-in registered by several panels is reported once. */
test("uniqueBuiltInShortcuts collapses duplicate registrations", () => {
  const scoped = { ...UNDO, componentId: "panel-a" };
  assert.deepEqual(uniqueBuiltInShortcuts([UNDO, HELP, UNDO, scoped, HELP]), [
    HELP,
    UNDO,
    scoped,
  ]);
});

/** Verifies disabling is idempotent and re-enabling removes only the named shortcut. */
test("disabled built-in list adds and removes shortcuts by identity", () => {
  const scopedUndo: BuiltInShortcutInfo = { ...UNDO, componentId: "panel-a" };
  const withUndo = withBuiltInShortcutDisabled([], scopedUndo);
  assert.deepEqual(withUndo, [{ key: "Control+z", description: "Undo" }]);
  const withBoth = withBuiltInShortcutDisabled(
    withBuiltInShortcutDisabled(withUndo, UNDO),
    HELP,
  );
  assert.deepEqual(withBoth, [
    { key: "Control+z", description: "Undo" },
    { key: "Shift+?", description: "Show shortcuts" },
  ]);
  assert.deepEqual(withBuiltInShortcutEnabled(withBoth, UNDO), [
    { key: "Shift+?", description: "Show shortcuts" },
  ]);
});

/** Verifies stored disabled lists drop malformed entries and extra fields. */
test("decodeDisabledBuiltInShortcuts keeps only well-formed entries", () => {
  assert.deepEqual(
    decodeDisabledBuiltInShortcuts(
      JSON.stringify([
        { key: "Control+z", description: "Undo", extra: 1 },
        { key: 5, description: "Bad" },
        "Shift+?",
      ]),
    ),
    [{ key: "Control+z", description: "Undo" }],
  );
  assert.deepEqual(decodeDisabledBuiltInShortcuts("{"), []);
  assert.deepEqual(decodeDisabledBuiltInShortcuts('{"key":"x"}'), []);
});
