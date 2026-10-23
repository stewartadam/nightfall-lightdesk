// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { mergeShortcutRows, type ShortcutRow } from "./shortcut-search";

/** Label of the group for shortcuts that belong to no panel. */
export const GLOBAL_GROUP = "Global";

/** The fields of a registered shortcut that decide where it is listed. */
export interface GroupableShortcut {
  description: string;
  key: string;
  componentId?: string;
}

/** One heading of the shortcuts list and the rows under it. */
export interface ShortcutGroup {
  label: string;
  /** Whether the group holds shortcuts of the panel that was active when the list opened. */
  active: boolean;
  rows: ShortcutRow[];
}

/**
 * Collects shortcuts under their group labels, so every open instance of a panel type shares one
 * heading, then orders the headings: Global first, the active panel's group next, and the rest
 * alphabetically. Within a group, shortcuts are sorted by key and merged into one row per action,
 * which also drops the identical bindings each extra panel instance registers.
 */
export function groupShortcuts<Shortcut extends GroupableShortcut>(
  shortcuts: readonly Shortcut[],
  labelFor: (shortcut: Shortcut) => string,
  activeComponentId: string | null,
): ShortcutGroup[] {
  const groups = new Map<string, { active: boolean; shortcuts: Shortcut[] }>();
  for (const shortcut of shortcuts) {
    const label = labelFor(shortcut);
    let group = groups.get(label);
    if (!group) {
      group = { active: false, shortcuts: [] };
      groups.set(label, group);
    }
    group.shortcuts.push(shortcut);
    if (
      activeComponentId !== null &&
      shortcut.componentId === activeComponentId
    )
      group.active = label !== GLOBAL_GROUP;
  }

  /** Global first, then the active panel's group, then alphabetical by label. */
  const rank = (label: string, active: boolean) =>
    label === GLOBAL_GROUP ? 0 : active ? 1 : 2;

  return [...groups.entries()]
    .sort(
      ([labelA, a], [labelB, b]) =>
        rank(labelA, a.active) - rank(labelB, b.active) ||
        labelA.localeCompare(labelB),
    )
    .map(([label, group]) => ({
      label,
      active: group.active,
      rows: mergeShortcutRows(
        [...group.shortcuts].sort((a, b) =>
          a.key.localeCompare(b.key, undefined, { numeric: true }),
        ),
      ),
    }));
}
