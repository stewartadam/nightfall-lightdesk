// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { BookOpenIcon } from "@squidlab/phosphor-solid/book-open";
import { FileArrowDownIcon } from "@squidlab/phosphor-solid/file-arrow-down";
import { FilePlusIcon } from "@squidlab/phosphor-solid/file-plus";
import { FileTextIcon } from "@squidlab/phosphor-solid/file-text";
import { FolderOpenIcon } from "@squidlab/phosphor-solid/folder-open";
import { GearIcon } from "@squidlab/phosphor-solid/gear";
import { GraduationCapIcon } from "@squidlab/phosphor-solid/graduation-cap";
import { InfoIcon } from "@squidlab/phosphor-solid/info";
import { QuestionIcon } from "@squidlab/phosphor-solid/question";
import { type JSX, Show } from "solid-js";
import { openWelcomeGuide } from "../../../features/welcome-guide";
import { hasDiskStorage } from "../../../lib/disk-storage";
import { openDocumentation, openFeedbackPage } from "../../../lib/feedback";
import { getLogger } from "../../../lib/logger";
import {
  newShowfile,
  promptForNewShowfile,
  saveShowfile,
} from "../../../lib/showfile-actions";
import { isTauriRuntime } from "../../../lib/tauri";
import {
  invokeTauriMenuAction,
  TAURI_MENU_SHORTCUTS,
} from "../../../lib/tauri-menu";
import { runtimeCapabilities } from "../../../state/appStores";
import { useAppShell } from "../../providers/app-shell";
import { useUiActionShortcutHint } from "../../providers/command-registry";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubmenu,
} from "../../ui/dropdown-menu";
import { formatShortcutHint } from "../../ui/kbd-keys";
import { TOOLBAR_BUTTON_CLASS } from "../../ui/toolbar-button";
import type { ButtonSize } from "../../ui/visual-language/button";
import { OPEN_SETTINGS_ACTION_ID } from "../command-palette/commands/settings-command";
import { SHOW_KEYBOARD_SHORTCUTS_ACTION_ID } from "../docking/layout-commands";

const log = getLogger(import.meta.url);

/**
 * The application menu: showfile actions, settings, help and troubleshooting.
 * The docked status bar opens it upward from its corner; the compact top bar
 * opens it downward and adds its own items above the shared ones.
 */
export default function AppMenu(props: {
  trigger: JSX.Element;
  triggerLabel: string;
  triggerClass?: string;
  /** Gives the trigger the shared `Button` look at this size instead of the toolbar look. */
  triggerSize?: ButtonSize;
  placement?: "above" | "below";
  align?: "start" | "end";
  /**
   * Builds items shown before the shared ones, followed by a separator. It is
   * a function so the items are created inside the menu, where they can close it.
   */
  leadingItems?: () => JSX.Element;
}) {
  const {
    openAbout,
    openDiagnostics,
    openSettings,
    showShortcutsPopup,
    showOpenShowfileModal,
    showShowfileImportModal,
    showShowfileExportModal,
  } = useAppShell();
  const capabilities = useStore(runtimeCapabilities);
  const settingsShortcut = useUiActionShortcutHint(OPEN_SETTINGS_ACTION_ID);
  const shortcutsShortcut = useUiActionShortcutHint(
    SHOW_KEYBOARD_SHORTCUTS_ACTION_ID,
  );
  /**
   * Labels a showfile item with its desktop menu shortcut. Browsers keep these keys for their
   * own Save and Open commands, so the hint appears only in the desktop app, which binds them.
   */
  const desktopShortcut = (shortcut: string) =>
    isTauriRuntime() ? formatShortcutHint(shortcut) : undefined;

  /** Shows the new, open, import, save, and export items only when the backend can store shows on disk. */
  const showStorageItems = () => hasDiskStorage(capabilities());

  /** Prompts for a show name before starting a fresh showfile. */
  const promptAndNewShowfile = () => {
    void (async () => {
      const options = await promptForNewShowfile();
      if (!options) return;
      newShowfile(options);
    })();
  };

  return (
    <DropdownMenu
      triggerLabel={props.triggerLabel}
      triggerTitle={props.triggerLabel}
      triggerClass={
        props.triggerClass ??
        (props.triggerSize ? undefined : TOOLBAR_BUTTON_CLASS)
      }
      triggerSize={props.triggerSize}
      placement={props.placement}
      align={props.align}
      trigger={props.trigger}
    >
      <Show when={props.leadingItems !== undefined}>
        {props.leadingItems?.()}
        <DropdownMenuSeparator />
      </Show>
      <Show when={showStorageItems()}>
        <DropdownMenuItem
          icon={FilePlusIcon}
          shortcut={desktopShortcut(TAURI_MENU_SHORTCUTS.newShowfile)}
          onClick={promptAndNewShowfile}
        >
          New Showfile
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={FolderOpenIcon}
          shortcut={desktopShortcut(TAURI_MENU_SHORTCUTS.loadShowfile)}
          onClick={() => {
            showOpenShowfileModal();
          }}
        >
          Open Showfile
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={FileArrowDownIcon}
          onClick={showShowfileImportModal}
        >
          Import Showfile
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={FileArrowDownIcon}
          shortcut={desktopShortcut(TAURI_MENU_SHORTCUTS.saveShowfile)}
          onClick={saveShowfile}
        >
          <span data-guide-target="save-showfile">Save Showfile</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={FileArrowDownIcon}
          onClick={showShowfileExportModal}
        >
          Export Showfile
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </Show>
      <DropdownMenuItem icon={GraduationCapIcon} onClick={openWelcomeGuide}>
        Welcome Guide
      </DropdownMenuItem>
      <DropdownMenuItem icon={BookOpenIcon} onClick={openDocumentation}>
        User Guide
      </DropdownMenuItem>
      <DropdownMenuItem
        icon={QuestionIcon}
        onClick={() => openFeedbackPage("feedback")}
      >
        Give Feedback
      </DropdownMenuItem>
      <DropdownMenuSubmenu label="Troubleshooting" icon={GearIcon}>
        <Show when={isTauriRuntime()}>
          <DropdownMenuItem
            icon={FileTextIcon}
            onClick={() => {
              void invokeTauriMenuAction("view.open_log").catch(
                (error: unknown) => {
                  log.error("Could not open the application log", { error });
                },
              );
            }}
          >
            Open Log
          </DropdownMenuItem>
        </Show>
        <DropdownMenuItem
          icon={QuestionIcon}
          onClick={() => openFeedbackPage("bug")}
        >
          Report a Bug
        </DropdownMenuItem>
        <DropdownMenuItem icon={FileTextIcon} onClick={openDiagnostics}>
          Collect Diagnostics
        </DropdownMenuItem>
      </DropdownMenuSubmenu>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        icon={GearIcon}
        onClick={openSettings}
        shortcut={settingsShortcut()}
      >
        Settings
      </DropdownMenuItem>
      <DropdownMenuItem
        icon={QuestionIcon}
        onClick={showShortcutsPopup}
        shortcut={shortcutsShortcut()}
      >
        <span data-guide-target="keyboard-shortcuts">Keyboard Shortcuts</span>
      </DropdownMenuItem>
      <DropdownMenuItem icon={InfoIcon} onClick={openAbout}>
        About
      </DropdownMenuItem>
    </DropdownMenu>
  );
}
