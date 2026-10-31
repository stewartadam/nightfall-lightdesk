// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, onCleanup, onMount } from "solid-js";
import { boardDisplayName } from "../../../features/boards";
import {
  OPEN_OBJECT_PALETTE_SHORTCUT,
  useShowfileObjectPalette,
} from "../../../features/showfile";
import { getLogger } from "../../../lib/logger";
import { findPanelDefinitionByName } from "../../../lib/panel-definitions";
import {
  type DesktopMenuEntry,
  registerTauriMenuListener,
  setDesktopViewMenu,
  toTauriAccelerator,
  WEB_MENU_ID_PREFIX,
} from "../../../lib/tauri-menu";
import {
  activeBoardWorkspace,
  activeLayoutId,
} from "../../../state/layout-switcher";
import { useAppShell } from "../../providers/app-shell";
import {
  $uiActions,
  executeUiAction,
  OPEN_COMMAND_PALETTE_SHORTCUT,
  uiActionId,
} from "../../providers/command-registry";
import { useCommandPalette } from "../command-palette";
import {
  recallSwitcherLayout,
  showSwitcherBoard,
  useSwitcherEntries,
} from "../header/switcher-entries";

const log = getLogger(import.meta.url);

/** Panels the View menu opens directly, by component name, in menu order. */
const VIEW_MENU_PANELS = [
  "CommandLine",
  "PatchEditor",
  "IoTransports",
  "DmxUniverse",
] as const;

/** UI action that opens layout management, withheld from the compact shell. */
const MANAGE_LAYOUTS_ACTION_ID = "manage-layouts";

/** A web-defined menu item together with what choosing it does. */
interface ViewMenuItem {
  entry: DesktopMenuEntry;
  run?: () => void;
}

/**
 * Fills the desktop app's native View menu from the web UI's own commands, panels and layout
 * switcher, and runs the items when chosen.
 *
 * Labels and keys come from the same definitions the web UI binds, so the native menu always
 * offers what this window can open and advertises the shortcuts that really open it. Items whose
 * action is unavailable, such as Layout Manager in the compact shell, are left out.
 */
export default function DesktopViewMenu() {
  const { showPalette } = useCommandPalette();
  const { showPalette: showObjectPalette } = useShowfileObjectPalette();
  const { dockviewApi } = useAppShell();
  const actions = useStore($uiActions);
  const activeLayout = useStore(activeLayoutId);
  const shownBoard = useStore(activeBoardWorkspace);
  const switcher = useSwitcherEntries();

  /** Builds a menu item that runs a registered UI action, or nothing when it is unavailable. */
  const uiActionItem = (
    actionId: string,
    menuId: string,
    label: string,
    shortcut?: string,
  ): ViewMenuItem[] => {
    if (!actions().some((action) => action.id === actionId)) return [];
    return [
      {
        entry: {
          kind: "item",
          id: `${WEB_MENU_ID_PREFIX}${menuId}`,
          label,
          accelerator: shortcut ? toTauriAccelerator(shortcut) : undefined,
        },
        run: () => {
          executeUiAction(uiActionId({ id: actionId }), { source: "menu" });
        },
      },
    ];
  };

  /** Lists the switcher's layouts, then its boards, checking the one filling the workspace. */
  const layoutItems = (): ViewMenuItem[] => {
    const layouts = switcher.layouts().map(
      (layout): ViewMenuItem => ({
        entry: {
          kind: "item",
          id: `${WEB_MENU_ID_PREFIX}layout.${layout.id}`,
          label: layout.name,
          checked: !shownBoard() && activeLayout() === layout.id,
        },
        run: () => void recallSwitcherLayout(dockviewApi(), layout.id),
      }),
    );
    const boards = switcher.boards().map(
      (board): ViewMenuItem => ({
        entry: {
          kind: "item",
          id: `${WEB_MENU_ID_PREFIX}board.${board.identifiers.uid}`,
          label: boardDisplayName(board),
          checked: shownBoard() === board.identifiers.uid,
        },
        run: () => {
          if (dockviewApi()) showSwitcherBoard(board.identifiers.uid);
        },
      }),
    );
    const separator: ViewMenuItem[] =
      layouts.length > 0 && boards.length > 0
        ? [{ entry: { kind: "separator" } }]
        : [];
    return [...layouts, ...separator, ...boards];
  };

  /** Lists the panels the View menu opens directly, in the order they are declared. */
  const panelItems = (): ViewMenuItem[] =>
    VIEW_MENU_PANELS.flatMap((componentName) => {
      const definition = findPanelDefinitionByName(componentName);
      if (!definition) return [];
      return uiActionItem(
        definition.panelId,
        `panel.${definition.panelId}`,
        definition.title,
        definition.shortcut,
      );
    });

  /** Assembles the whole View menu, keeping each item's behavior beside its entry. */
  const menu = createMemo(() => {
    const layouts = layoutItems();
    const items: (ViewMenuItem | ViewMenuItem[])[] = [
      {
        entry: {
          kind: "item",
          id: `${WEB_MENU_ID_PREFIX}command-palette`,
          label: "Command Palette...",
          accelerator: toTauriAccelerator(OPEN_COMMAND_PALETTE_SHORTCUT),
        },
        run: showPalette,
      },
      {
        entry: {
          kind: "item",
          id: `${WEB_MENU_ID_PREFIX}object-palette`,
          label: "Object Palette...",
          accelerator: toTauriAccelerator(OPEN_OBJECT_PALETTE_SHORTCUT),
        },
        run: showObjectPalette,
      },
      { entry: { kind: "separator" } },
      layouts.length > 0
        ? {
            entry: {
              kind: "submenu",
              label: "Layout",
              items: layouts.map((item) => item.entry),
            },
          }
        : [],
      uiActionItem(
        MANAGE_LAYOUTS_ACTION_ID,
        "layout-manager",
        "Layout Manager...",
      ),
      { entry: { kind: "separator" } },
      panelItems(),
    ];
    const flat = items.flat();
    const handlers = new Map<string, () => void>();
    for (const item of [...flat, ...layouts]) {
      if (item.entry.kind === "item" && item.run)
        handlers.set(item.entry.id, item.run);
    }
    return { entries: flat.map((item) => item.entry), handlers };
  });

  /** Serialized entries last sent to the native shell, so unchanged menus are not rebuilt. */
  let sentEntries: string | undefined;

  /**
   * Sends the current entries to the native shell when they differ from what it last received,
   * or unconditionally when `force` is set.
   *
   * Forcing restores the native menu after the shell changed it on its own: a check item toggles
   * its mark when clicked, and another window may have pushed its own layouts and check marks.
   */
  const pushMenu = (force = false) => {
    const entries = menu().entries;
    const serialized = JSON.stringify(entries);
    if (!force && serialized === sentEntries) return;
    sentEntries = serialized;
    setDesktopViewMenu(entries).catch((error: unknown) => {
      sentEntries = undefined;
      log.error("Could not update the desktop View menu", { error });
    });
  };

  /**
   * Pushes the menu whenever its contents change. Layout storage and the action registry update
   * often, on every panel resize or mount, so identical menus are skipped rather than rebuilt.
   */
  createEffect(() => pushMenu());

  /** Reclaims the shared native menu for this window's layouts and actions when it gains focus. */
  const reclaimMenu = () => pushMenu(true);
  window.addEventListener("focus", reclaimMenu);
  onCleanup(() => window.removeEventListener("focus", reclaimMenu));

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void registerTauriMenuListener({
      webMenuAction: (id) => {
        menu().handlers.get(id)?.();
        // A clicked check item flips its own mark; restore the web UI's state.
        pushMenu(true);
      },
    })
      .then((handler) => {
        if (disposed) {
          handler();
          return;
        }
        unlisten = handler;
      })
      .catch((error: unknown) => {
        log.error("Failed to register desktop View menu listener:", { error });
      });

    onCleanup(() => {
      disposed = true;
      unlisten?.();
    });
  });

  return null;
}
