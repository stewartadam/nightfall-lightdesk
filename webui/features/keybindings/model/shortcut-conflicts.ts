// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { matchKeybindingPress, parseKeybinding } from "tinykeys";
import type * as types from "../../../types";

/** Identity of one built-in shortcut: its registered key and description. */
export interface BuiltInShortcutRef {
  /** Key combination in the syntax the shortcut registered with, such as `$mod+z`. */
  key: string;
  /** Human-readable description the shortcut registered with. */
  description: string;
}

/** A built-in shortcut with the scope it applies in. */
export interface BuiltInShortcutInfo extends BuiltInShortcutRef {
  /** Panel the shortcut is limited to, or undefined for a global shortcut. */
  componentId?: string;
  /** Group name the shortcuts overlay lists the shortcut under. */
  group?: string;
}

/** A user keybinding as far as conflict detection needs it. */
export interface KeybindingLike {
  id: string;
  key: string;
  action: types.ActionReference;
}

/** Something already bound to a key combination that a new keybinding would shadow or replace. */
export type KeybindingConflict =
  | { kind: "built-in"; shortcut: BuiltInShortcutInfo }
  | { kind: "keybinding"; binding: KeybindingLike };

/** Minimal keyboard event shape tinykeys needs to match a key press. */
interface KeyPress {
  key: string;
  code: string;
  getModifierState: (modifier: string) => boolean;
}

/**
 * Rebuilds the key press a stored keybinding was recorded from.
 *
 * Letter and digit bindings store physical codes, so both `key` and `code` are restored for
 * them; other keys were stored by their `KeyboardEvent.key` value.
 */
function pressFromKey(key: string): KeyPress {
  const parts = key.split("+");
  const last = parts.pop() ?? "";
  const modifiers = new Set(parts);
  const letter = /^Key([A-Z])$/.exec(last);
  const digit = /^Digit([0-9])$/.exec(last);
  const [eventKey, code] = letter
    ? [letter[1].toLowerCase(), last]
    : digit
      ? [digit[1], last]
      : last === "Space"
        ? [" ", "Space"]
        : last === "`" || last === "~"
          ? [last, "Backquote"]
          : [last, last];
  return {
    key: eventKey,
    code,
    getModifierState: (modifier) => modifiers.has(modifier),
  };
}

/**
 * Returns whether a built-in shortcut fires for a stored keybinding's key combination.
 *
 * Multi-press sequences never match, since a keybinding is a single press.
 */
export function builtInShortcutMatchesKey(
  shortcutKey: string,
  key: string,
): boolean {
  // Mirrors the dispatcher, which matches backquote shortcuts by physical key since Shift
  // turns the produced character into a tilde.
  const normalized =
    shortcutKey === " "
      ? "Space"
      : shortcutKey.replace(/(^|\+)[`~]$/, "$1Backquote");
  const presses = parseKeybinding(normalized);
  if (presses.length !== 1) return false;
  const press = pressFromKey(key);
  return (
    matchKeybindingPress(press as unknown as KeyboardEvent, presses[0]) ||
    (shortcutKey === "Shift+/" && key === "Shift+?")
  );
}

/** Returns whether two references name the same built-in shortcut. */
export function isSameBuiltInShortcut(
  a: BuiltInShortcutRef,
  b: BuiltInShortcutRef,
): boolean {
  return a.key === b.key && a.description === b.description;
}

/** Returns whether a built-in shortcut is in the disabled list. */
export function isBuiltInShortcutDisabled(
  shortcut: BuiltInShortcutRef,
  disabled: readonly BuiltInShortcutRef[],
): boolean {
  return disabled.some((entry) => isSameBuiltInShortcut(entry, shortcut));
}

/** Returns the disabled list with one built-in shortcut added, keeping entries unique. */
export function withBuiltInShortcutDisabled(
  disabled: readonly BuiltInShortcutRef[],
  shortcut: BuiltInShortcutRef,
): BuiltInShortcutRef[] {
  if (isBuiltInShortcutDisabled(shortcut, disabled)) return [...disabled];
  return [
    ...disabled,
    { key: shortcut.key, description: shortcut.description },
  ];
}

/** Returns the disabled list without one built-in shortcut. */
export function withBuiltInShortcutEnabled(
  disabled: readonly BuiltInShortcutRef[],
  shortcut: BuiltInShortcutRef,
): BuiltInShortcutRef[] {
  return disabled.filter((entry) => !isSameBuiltInShortcut(entry, shortcut));
}

/**
 * Returns registered built-in shortcuts once each, ordered by description.
 *
 * The same shortcut registers once per mounted panel instance, so duplicates by key,
 * description, and scope collapse into one entry.
 */
export function uniqueBuiltInShortcuts(
  shortcuts: readonly BuiltInShortcutInfo[],
): BuiltInShortcutInfo[] {
  const seen = new Set<string>();
  const unique: BuiltInShortcutInfo[] = [];
  for (const shortcut of shortcuts) {
    const identity = JSON.stringify([
      shortcut.key,
      shortcut.description,
      shortcut.componentId ?? null,
    ]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(shortcut);
  }
  return unique.sort(
    (a, b) =>
      a.description.localeCompare(b.description) || a.key.localeCompare(b.key),
  );
}

/**
 * Lists what a new keybinding on `key` would shadow or replace.
 *
 * Built-in shortcuts that fire for the key are shadowed while the keybinding exists, unless
 * they are disabled. Other user keybindings on the same key are replaced. The binding being
 * edited, named by `editingId`, is not its own conflict.
 */
export function findKeybindingConflicts(
  key: string,
  builtIns: readonly BuiltInShortcutInfo[],
  bindings: readonly KeybindingLike[],
  disabled: readonly BuiltInShortcutRef[],
  editingId?: string,
): KeybindingConflict[] {
  const builtInConflicts = uniqueBuiltInShortcuts(builtIns)
    .filter(
      (shortcut) =>
        !isBuiltInShortcutDisabled(shortcut, disabled) &&
        builtInShortcutMatchesKey(shortcut.key, key),
    )
    .map((shortcut): KeybindingConflict => ({ kind: "built-in", shortcut }));
  const bindingConflicts = bindings
    .filter((binding) => binding.key === key && binding.id !== editingId)
    .map((binding): KeybindingConflict => ({ kind: "keybinding", binding }));
  return [...builtInConflicts, ...bindingConflicts];
}

/** Parses a stored disabled built-in shortcut list, dropping malformed entries. */
export function decodeDisabledBuiltInShortcuts(
  value: string,
): BuiltInShortcutRef[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is BuiltInShortcutRef =>
          typeof entry?.key === "string" &&
          typeof entry?.description === "string",
      )
      .map(({ key, description }) => ({ key, description }));
  } catch {
    return [];
  }
}
