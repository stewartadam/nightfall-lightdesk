// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { describeKey, formatShortcutLabel, parseShortcut } from "./kbd-keys";

/** Verifies the plain-text label uses the cap names, joins keys with `+` and chord steps with `then`. */
test("formatShortcutLabel spells shortcuts with the key cap names", () => {
  assert.equal(formatShortcutLabel("Alt+Shift+KeyM", false), "Alt + Shift + M");
  assert.equal(formatShortcutLabel("$mod+,", false), "Ctrl + ,");
  assert.equal(formatShortcutLabel("$mod+,", true), "Command + ,");
  assert.equal(formatShortcutLabel("$mod+k w", false), "Ctrl + K then W");
  assert.equal(formatShortcutLabel("Shift++", false), "Shift + +");
});

/** Verifies combinations split on `+`, chords split on whitespace, and a literal `+` key survives. */
test("parseShortcut splits combinations, chords and literal plus keys", () => {
  assert.deepEqual(parseShortcut("$mod+Shift+p"), [["$mod", "Shift", "p"]]);
  assert.deepEqual(parseShortcut("$mod+k w"), [["$mod", "k"], ["w"]]);
  assert.deepEqual(parseShortcut("Shift++"), [["Shift", "+"]]);
  assert.deepEqual(parseShortcut("+"), [["+"]]);
  assert.deepEqual(parseShortcut("Enter"), [["Enter"]]);
});

/** Verifies `$mod` and platform modifiers resolve to Apple glyphs or Windows/Linux labels. */
test("describeKey resolves modifiers per platform", () => {
  assert.deepEqual(describeKey("$mod", true), {
    label: "Command",
    glyph: "command",
  });
  assert.deepEqual(describeKey("$mod", false), {
    label: "Ctrl",
    title: "Control",
  });
  assert.deepEqual(describeKey("Meta", true), {
    label: "Command",
    glyph: "command",
  });
  assert.deepEqual(describeKey("Alt", true), {
    label: "Option",
    glyph: "option",
  });
  assert.deepEqual(describeKey("Alt", false), { label: "Alt" });
  assert.deepEqual(describeKey("Control", false), {
    label: "Ctrl",
    title: "Control",
  });
  assert.equal(describeKey("Shift", false).glyph, "shift");
  assert.deepEqual(describeKey("Backspace", false), {
    label: "Backspace",
    glyph: "backspace",
  });
});

/** Verifies physical key codes, letters and named keys get their conventional cap labels. */
test("describeKey labels letters, codes and named keys", () => {
  assert.equal(describeKey("KeyM", false).label, "M");
  assert.equal(describeKey("Digit4", false).label, "4");
  assert.equal(describeKey("p", false).label, "P");
  assert.equal(describeKey("ArrowUp", false).label, "↑");
  assert.equal(describeKey("Escape", false).label, "Esc");
  assert.equal(describeKey("Keyboard", false).label, "Keyboard");
  assert.equal(describeKey("?", false).label, "?");
});
