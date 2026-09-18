// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import type { ContextMenuEntry } from "../../widgets/context-menu";

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuEntry[];
}

const [contextMenuState, setContextMenuState] =
  createSignal<ContextMenuState | null>(null);

/** Opens the shared context-menu host with normalized separator placement. */
export function openContextMenu(options: ContextMenuState): void {
  const items = options.items.filter((item, index, allItems) => {
    if (item.type !== "separator") return true;
    const previous = allItems[index - 1];
    const next = allItems[index + 1];
    return previous?.type !== "separator" && next?.type !== "separator";
  });
  if (items.length === 0) return;
  setContextMenuState({ ...options, items });
}

/** Closes the shared context-menu host. */
export function closeContextMenu(): void {
  setContextMenuState(null);
}

export type {
  ContextMenuEntry,
  ContextMenuHeading,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubmenu,
} from "../../widgets/context-menu";
export { contextMenuState };
