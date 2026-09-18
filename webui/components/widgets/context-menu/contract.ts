// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { AppIcon } from "../../ui/icon";

export interface ContextMenuItem {
  type?: "item";
  id: string;
  label: string;
  icon?: AppIcon;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

export interface ContextMenuSeparator {
  type: "separator";
  id: string;
}

export interface ContextMenuHeading {
  type: "heading";
  id: string;
  label: string;
}

export interface ContextMenuSubmenu {
  type: "submenu";
  id: string;
  label: string;
  icon?: AppIcon;
  disabled?: boolean;
  items: ContextMenuEntry[];
}

export type ContextMenuEntry =
  | ContextMenuItem
  | ContextMenuSeparator
  | ContextMenuHeading
  | ContextMenuSubmenu;

/** Returns whether a menu entry directly invokes a command. */
export function isSelectableMenuItem(
  entry: ContextMenuEntry,
): entry is ContextMenuItem {
  return entry.type === undefined || entry.type === "item";
}

/** Returns whether a menu entry owns a nested flyout menu. */
export function isContextSubmenu(
  entry: ContextMenuEntry,
): entry is ContextMenuSubmenu {
  return entry.type === "submenu";
}
