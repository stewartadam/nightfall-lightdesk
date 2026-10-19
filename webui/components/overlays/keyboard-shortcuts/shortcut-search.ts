// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  describeKey,
  formatShortcutLabel,
  IS_APPLE_PLATFORM,
  parseShortcut,
} from "../../ui/kbd-keys";
import { matchesSearchTerms } from "../../ui/search-match";

/** Shorthand people commonly type for modifier keys whose caps spell the full name. */
const KEY_ALIASES: Record<string, string> = {
  Command: "cmd",
  Control: "ctrl",
  Option: "opt",
};

/** A shortcut as the search sees it: its description, key binding and the group it is listed under. */
export interface SearchableShortcut {
  description: string;
  key: string;
  groupLabel: string;
}

/**
 * Builds the lower-case text a shortcut is searched against: its description, group label and
 * keys as the key caps name them (for example `ctrl + shift + p`), the same keys written without
 * spaces (`ctrl+shift+p`), the same again with modifier shorthand (`cmd+shift+p`), and full names
 * behind abbreviated caps (`escape` for `Esc`).
 */
export function shortcutSearchText(
  shortcut: SearchableShortcut,
  applePlatform: boolean = IS_APPLE_PLATFORM,
): string {
  const label = formatShortcutLabel(shortcut.key, applePlatform);
  const steps = parseShortcut(shortcut.key).map((keys) =>
    keys.map((key) => describeKey(key, applePlatform)),
  );
  const shorthand = steps
    .map((faces) =>
      faces.map((face) => KEY_ALIASES[face.label] ?? face.label).join("+"),
    )
    .join(" then ");
  const fullNames = steps.flat().flatMap((face) => face.title ?? []);
  return [
    shortcut.description,
    shortcut.groupLabel,
    label,
    label.replace(/ \+ /g, "+"),
    shorthand,
    ...fullNames,
  ]
    .join(" ")
    .toLocaleLowerCase();
}

/** One row of the shortcuts list: an action and every key that triggers it. */
export interface ShortcutRow {
  description: string;
  keys: string[];
}

/**
 * Collapses shortcuts that share a description into one row listing each of their keys, such as
 * Backspace and Delete both deleting the selection. Rows keep the order in which each
 * description first appears, and keys keep their input order without repeats, so two open
 * instances of a panel binding the same key list it once.
 */
export function mergeShortcutRows(
  shortcuts: readonly { description: string; key: string }[],
): ShortcutRow[] {
  const rows = new Map<string, ShortcutRow>();
  for (const shortcut of shortcuts) {
    const row = rows.get(shortcut.description);
    if (row) {
      if (!row.keys.includes(shortcut.key)) row.keys.push(shortcut.key);
    } else {
      rows.set(shortcut.description, {
        description: shortcut.description,
        keys: [shortcut.key],
      });
    }
  }
  return [...rows.values()];
}

/** Returns whether every search term appears somewhere in the shortcut's searchable text. */
export function matchesShortcutSearch(
  terms: readonly string[],
  shortcut: SearchableShortcut,
  applePlatform: boolean = IS_APPLE_PLATFORM,
): boolean {
  if (terms.length === 0) return true;
  return matchesSearchTerms(terms, [
    shortcutSearchText(shortcut, applePlatform),
  ]);
}
