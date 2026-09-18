// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { onCleanup, onMount } from "solid-js";
import { engineRuntime } from "../../../lib/engine-runtime";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import {
  newShowfile,
  promptForNewShowfileName,
  saveShowfile,
} from "../../../lib/showfile-actions";
import { isTauriRuntime } from "../../../lib/tauri";
import {
  invokeTauriMenuAction,
  registerTauriMenuListener,
  TAURI_MENU_ACTIONS,
} from "../../../lib/tauri-menu";
import { useAppShell } from "../../providers/app-shell";
import { useCommandPalette } from "../command-palette";

const log = getLogger(import.meta.url);

/**
 * Bridges native Tauri menu events into existing web UI actions and shortcuts.
 */
export default function TauriMenuBridge() {
  const { showPalette } = useCommandPalette();
  const {
    openAbout,
    openSettings,
    showOpenShowfileModal,
    showShowfileExportModal,
    showShortcutsPopup,
  } = useAppShell();

  /** Prompts for a show name before starting a fresh showfile from the app menu. */
  const promptAndNewShowfile = () => {
    void (async () => {
      const showfileName = await promptForNewShowfileName();
      if (!showfileName) return;
      newShowfile(showfileName);
    })();
  };

  const isWindowsTauriRuntime = () => {
    if (!isTauriRuntime() || typeof navigator === "undefined") {
      return false;
    }

    const navigatorWithUserAgentData = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    const platform = (
      navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform
    ).toLowerCase();
    return platform.includes("win");
  };

  useKeyboardShortcut(
    {
      key: "$mod+Shift+/",
      handler: () => {
        if (!isWindowsTauriRuntime()) {
          return false;
        }

        showShortcutsPopup();
      },
      description: "Show keyboard shortcuts",
    },
    { global: true },
  );

  useKeyboardShortcut(
    {
      key: "$mod+n",
      handler: () => {
        if (!isWindowsTauriRuntime()) {
          return false;
        }

        void invokeTauriMenuAction(TAURI_MENU_ACTIONS.newWindow);
      },
      description: "New window",
    },
    { global: true },
  );

  useKeyboardShortcut(
    {
      key: "$mod+Shift+w",
      handler: () => {
        if (!isWindowsTauriRuntime()) {
          return false;
        }

        void invokeTauriMenuAction(TAURI_MENU_ACTIONS.closeWindow);
      },
      description: "Close window",
    },
    { global: true },
  );

  useKeyboardShortcut(
    {
      key: "$mod+Shift+n",
      handler: () => {
        if (!isWindowsTauriRuntime()) {
          return false;
        }

        void invokeTauriMenuAction(TAURI_MENU_ACTIONS.newShowfile);
      },
      description: "New showfile",
    },
    { global: true },
  );

  useKeyboardShortcut(
    {
      key: "$mod+o",
      handler: () => {
        if (!isWindowsTauriRuntime()) {
          return false;
        }

        void invokeTauriMenuAction(TAURI_MENU_ACTIONS.loadShowfile);
      },
      description: "Open showfile",
    },
    { global: true },
  );

  useKeyboardShortcut(
    {
      key: "$mod+s",
      handler: () => {
        if (!isWindowsTauriRuntime()) {
          return false;
        }

        void invokeTauriMenuAction(TAURI_MENU_ACTIONS.saveShowfile);
      },
      description: "Save showfile",
    },
    { global: true },
  );

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void registerTauriMenuListener({
      openAbout,
      openSettings,
      newShowfile: promptAndNewShowfile,
      openShowfile: showOpenShowfileModal,
      saveShowfile,
      exportShowfile: showShowfileExportModal,
      showCommandPalette: showPalette,
      showKeyboardShortcuts: showShortcutsPopup,
      undo: () => {
        engineRuntime.sendCommand({
          module: "UndoCommand",
          command: { type: "Undo", data: {} },
        });
      },
      redo: () => {
        engineRuntime.sendCommand({
          module: "UndoCommand",
          command: { type: "Redo", data: {} },
        });
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
        log.error("Failed to register Tauri menu listener:", { error });
      });

    onCleanup(() => {
      disposed = true;
      unlisten?.();
    });
  });

  return null;
}
