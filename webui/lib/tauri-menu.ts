// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { isTauriRuntime } from "./tauri";

const TAURI_MENU_ACTION_EVENT = "nightfall:menu-action";

export const TAURI_MENU_ACTIONS = {
  about: "app.about",
  welcomeGuide: "app.welcome_guide",
  documentation: "app.documentation",
  settings: "app.settings",
  diagnostics: "app.diagnostics",
  reportBug: "app.report_bug",
  newWindow: "window.new",
  closeWindow: "window.close",
  newShowfile: "showfile.new",
  loadShowfile: "showfile.load",
  saveShowfile: "showfile.save",
  exportShowfile: "showfile.export",
  undo: "edit.undo",
  redo: "edit.redo",
  commandPalette: "view.command_palette",
  keyboardShortcuts: "view.keyboard_shortcuts",
} as const;

/**
 * Keys the desktop app binds to its window and showfile menu actions, in keyboard shortcut
 * syntax. The native menu accelerators in `desktop_shell.rs` must match these; the web UI binds
 * them itself only where the native menu cannot, and labels its own menu items with them.
 */
export const TAURI_MENU_SHORTCUTS = {
  newWindow: "$mod+n",
  closeWindow: "$mod+Shift+w",
  newShowfile: "$mod+Shift+n",
  loadShowfile: "$mod+o",
  saveShowfile: "$mod+s",
} as const;

export interface TauriMenuActionHandlers {
  openAbout: () => void;
  openWelcomeGuide: () => void;
  openSettings: () => void;
  openDiagnostics: () => void;
  reportBug: () => void;
  newShowfile: () => void;
  openShowfile: () => void;
  saveShowfile: () => void;
  exportShowfile: () => void;
  showCommandPalette: () => void;
  showKeyboardShortcuts: () => void;
  undo: () => void;
  redo: () => void;
  /** Runs a web-defined menu item, identified by its `web.` menu id. */
  webMenuAction: (id: string) => void;
}

/**
 * Dispatches a Tauri menu action to the matching UI handler.
 */
export function handleTauriMenuAction(
  action: string,
  handlers: Partial<TauriMenuActionHandlers>,
): void {
  switch (action) {
    case TAURI_MENU_ACTIONS.reportBug:
      handlers.reportBug?.();
      return;
    case TAURI_MENU_ACTIONS.diagnostics:
      handlers.openDiagnostics?.();
      return;
    case TAURI_MENU_ACTIONS.about:
      handlers.openAbout?.();
      return;
    case TAURI_MENU_ACTIONS.welcomeGuide:
      handlers.openWelcomeGuide?.();
      return;
    case TAURI_MENU_ACTIONS.settings:
      handlers.openSettings?.();
      return;
    case TAURI_MENU_ACTIONS.newShowfile:
      handlers.newShowfile?.();
      return;
    case TAURI_MENU_ACTIONS.loadShowfile:
      handlers.openShowfile?.();
      return;
    case TAURI_MENU_ACTIONS.exportShowfile:
      handlers.exportShowfile?.();
      return;
    case TAURI_MENU_ACTIONS.saveShowfile:
      handlers.saveShowfile?.();
      return;
    case TAURI_MENU_ACTIONS.commandPalette:
      handlers.showCommandPalette?.();
      return;
    case TAURI_MENU_ACTIONS.keyboardShortcuts:
      handlers.showKeyboardShortcuts?.();
      return;
    case TAURI_MENU_ACTIONS.undo:
      handlers.undo?.();
      return;
    case TAURI_MENU_ACTIONS.redo:
      handlers.redo?.();
      return;
    default:
      if (action.startsWith(WEB_MENU_ID_PREFIX))
        handlers.webMenuAction?.(action);
      return;
  }
}

/**
 * Registers the current webview to receive forwarded native menu actions.
 */
export async function registerTauriMenuListener(
  handlers: Partial<TauriMenuActionHandlers>,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }

  const { getCurrentWebviewWindow } = await import(
    "@tauri-apps/api/webviewWindow"
  );

  return getCurrentWebviewWindow().listen<string>(
    TAURI_MENU_ACTION_EVENT,
    (event) => {
      handleTauriMenuAction(event.payload, handlers);
    },
  );
}

/**
 * Invokes the desktop-side menu dispatcher for actions triggered from the web UI.
 */
export async function invokeTauriMenuAction(action: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("perform_menu_action", { actionId: action });
}

/** Prefix of native menu ids whose items the web UI defines and runs itself. */
export const WEB_MENU_ID_PREFIX = "web.";

/** One entry of a native menu whose contents the web UI defines; see `set_view_menu`. */
export type DesktopMenuEntry =
  | {
      kind: "item";
      /** Menu id starting with {@link WEB_MENU_ID_PREFIX}, echoed back when chosen. */
      id: string;
      label: string;
      /** Native accelerator in Tauri syntax, from {@link toTauriAccelerator}. */
      accelerator?: string;
      /** Shows a check mark beside the item when set. */
      checked?: boolean;
    }
  | { kind: "separator" }
  | { kind: "submenu"; label: string; items: DesktopMenuEntry[] };

/** Accelerator spellings of the modifiers a native menu can safely claim from the webview. */
const ACCELERATOR_MODIFIERS: Record<string, string> = {
  $mod: "CmdOrCtrl",
  Control: "Ctrl",
  Meta: "Super",
  Alt: "Alt",
};

/**
 * Converts a web shortcut such as `$mod+Shift+p` into a native menu accelerator such as
 * `CmdOrCtrl+Shift+P`, so a native item advertises and handles the same key as the web UI.
 *
 * Returns undefined for shortcuts a native accelerator would break: chords, keys without a
 * Command, Control, Alt or Meta modifier (the menu would swallow them from text fields), and
 * keys other than letters, digits and function keys.
 */
export function toTauriAccelerator(shortcut: string): string | undefined {
  const steps = shortcut.trim().split(/\s+/);
  if (steps.length !== 1) return undefined;
  const keys = steps[0].split("+");
  const key = keys.pop()?.replace(/^Key(?=[A-Za-z]$)|^Digit(?=\d$)/, "");
  if (!key || !/^([A-Za-z0-9]|F([1-9]|1\d|2[0-4]))$/.test(key))
    return undefined;
  if (!keys.some((modifier) => modifier in ACCELERATOR_MODIFIERS))
    return undefined;
  const modifiers = keys.map((modifier) =>
    modifier === "Shift" ? "Shift" : ACCELERATOR_MODIFIERS[modifier],
  );
  if (modifiers.some((modifier) => modifier === undefined)) return undefined;
  return [...modifiers, key.toUpperCase()].join("+");
}

/** Replaces the desktop app's native View menu with web-defined entries. */
export async function setDesktopViewMenu(
  entries: DesktopMenuEntry[],
): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_view_menu", { entries });
}
