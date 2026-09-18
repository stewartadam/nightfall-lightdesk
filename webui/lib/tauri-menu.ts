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
export interface TauriMenuActionHandlers {
  openAbout: () => void;
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
