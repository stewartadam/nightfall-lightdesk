// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  closeContextMenu,
  contextMenuState,
} from "../../providers/context-menu";
import {
  type ContextMenuEntry,
  ContextMenuList,
  type ContextMenuSubmenuPathEntry,
} from "../../widgets/context-menu";

const MENU_MIN_WIDTH = 180;
const MENU_MAX_WIDTH = 360;
const MENU_MARGIN = 8;
const MENU_VERTICAL_PADDING = 5;
const MENU_ITEM_HORIZONTAL_PADDING = 20;
const MENU_ITEM_ICON_WIDTH = 16;
const MENU_ITEM_GAP_WIDTH = 12;
const MENU_ITEM_SUBMENU_CHEVRON_WIDTH = 10;
const MENU_ITEM_LABEL_CHAR_WIDTH = 7;
const MENU_ITEM_SHORTCUT_CHAR_WIDTH = 6;

/** Estimates the rendered height for one context-menu row. */
function contextMenuEntryHeight(entry: ContextMenuEntry): number {
  if (entry.type === "separator") return 7;
  if (entry.type === "heading") return 22;
  return 28;
}

/** Estimates the width needed for one context-menu row. */
function contextMenuEntryWidth(entry: ContextMenuEntry): number {
  if (entry.type === "separator") return MENU_MIN_WIDTH;
  if (entry.type === "heading") {
    return (
      MENU_ITEM_HORIZONTAL_PADDING +
      entry.label.length * MENU_ITEM_LABEL_CHAR_WIDTH
    );
  }
  const shortcutWidth =
    entry.type !== "submenu" && entry.shortcut
      ? MENU_ITEM_GAP_WIDTH +
        entry.shortcut.length * MENU_ITEM_SHORTCUT_CHAR_WIDTH
      : 0;
  const submenuChevronWidth =
    entry.type === "submenu"
      ? MENU_ITEM_GAP_WIDTH + MENU_ITEM_SUBMENU_CHEVRON_WIDTH
      : 0;
  return (
    MENU_ITEM_HORIZONTAL_PADDING +
    MENU_ITEM_ICON_WIDTH +
    MENU_ITEM_GAP_WIDTH +
    entry.label.length * MENU_ITEM_LABEL_CHAR_WIDTH +
    shortcutWidth +
    submenuChevronWidth
  );
}

/** Estimates menu width from its entries while preserving compact bounds. */
function contextMenuWidth(entries: readonly ContextMenuEntry[]): number {
  return Math.min(
    MENU_MAX_WIDTH,
    Math.max(MENU_MIN_WIDTH, ...entries.map(contextMenuEntryWidth)),
  );
}

/** Estimates menu height using fixed row heights and vertical padding. */
function contextMenuHeight(entries: readonly ContextMenuEntry[]): number {
  return (
    entries.reduce(
      (height, entry) => height + contextMenuEntryHeight(entry),
      0,
    ) +
    MENU_VERTICAL_PADDING * 2
  );
}

/** Estimates the top offset for a menu row inside its owning menu. */
function contextMenuEntryTopOffset(
  entries: readonly ContextMenuEntry[],
  entryIndex: number,
): number {
  return (
    MENU_VERTICAL_PADDING +
    entries
      .slice(0, entryIndex)
      .reduce((height, entry) => height + contextMenuEntryHeight(entry), 0)
  );
}

/** Mounts and positions the global context-menu overlay. */
export default function GlobalContextMenuHost() {
  /** Closes the active menu in response to the global Escape shortcut. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeContextMenu();
  };

  onMount(() => {
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  /** Computes viewport-clamped placement for the root menu. */
  const menuPosition = createMemo(() => {
    const state = contextMenuState();
    if (!state) return undefined;
    const width = contextMenuWidth(state.items);
    return {
      left: Math.max(
        MENU_MARGIN,
        Math.min(state.x, window.innerWidth - width - MENU_MARGIN),
      ),
      top: Math.max(
        MENU_MARGIN,
        Math.min(
          state.y,
          window.innerHeight - contextMenuHeight(state.items) - MENU_MARGIN,
        ),
      ),
      width,
    };
  });

  /** Places nested flyouts in viewport coordinates with adjoining borders, independent of menu padding. */
  const submenuStyle = (path: readonly ContextMenuSubmenuPathEntry[]) => {
    const state = contextMenuState();
    const position = menuPosition();
    if (!state || !position) return {};

    let parentItems: readonly ContextMenuEntry[] = state.items;
    let parentLeft = position.left;
    let parentTop = position.top;
    let parentWidth = position.width;
    let relativeStyle: JSX.CSSProperties = {};

    for (const { submenu, entryIndex } of path) {
      const width = contextMenuWidth(submenu.items);
      const preferredRight = parentLeft + parentWidth - 1;
      const preferredLeft = parentLeft - width + 1;
      const absoluteLeft =
        preferredRight + width <= window.innerWidth - MENU_MARGIN
          ? preferredRight
          : preferredLeft >= MENU_MARGIN
            ? preferredLeft
            : Math.max(
                MENU_MARGIN,
                Math.min(
                  preferredRight,
                  window.innerWidth - width - MENU_MARGIN,
                ),
              );
      const rowTop =
        parentTop + contextMenuEntryTopOffset(parentItems, entryIndex);
      const absoluteTop = Math.max(
        MENU_MARGIN,
        Math.min(
          rowTop,
          window.innerHeight - contextMenuHeight(submenu.items) - MENU_MARGIN,
        ),
      );
      relativeStyle = {
        position: "fixed",
        left: `${absoluteLeft}px`,
        top: `${absoluteTop}px`,
        width: `${width}px`,
      };
      parentItems = submenu.items;
      parentLeft = absoluteLeft;
      parentTop = absoluteTop;
      parentWidth = width;
    }

    return relativeStyle;
  };

  /** Converts the root menu position to Solid's style-object contract. */
  const positionStyle = () => {
    const position = menuPosition();
    return position
      ? {
          left: `${position.left}px`,
          top: `${position.top}px`,
          width: `${position.width}px`,
        }
      : {};
  };

  return (
    <Show when={contextMenuState()}>
      {(state) => (
        <Portal>
          <div
            class="fixed inset-0 nightfall-top-layer"
            onPointerDown={closeContextMenu}
            onContextMenu={(event) => {
              event.preventDefault();
              closeContextMenu();
            }}
          >
            <ContextMenuList
              items={state().items}
              style={positionStyle()}
              submenuStyle={submenuStyle}
              onSelect={(item) => {
                item.onSelect();
                closeContextMenu();
              }}
            />
          </div>
        </Portal>
      )}
    </Show>
  );
}
