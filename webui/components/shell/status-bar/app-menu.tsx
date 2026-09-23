// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FileArrowDownIcon } from "@squidlab/phosphor-solid/file-arrow-down";
import { FilePlusIcon } from "@squidlab/phosphor-solid/file-plus";
import { FileTextIcon } from "@squidlab/phosphor-solid/file-text";
import { FolderOpenIcon } from "@squidlab/phosphor-solid/folder-open";
import { GearIcon } from "@squidlab/phosphor-solid/gear";
import { InfoIcon } from "@squidlab/phosphor-solid/info";
import { QuestionIcon } from "@squidlab/phosphor-solid/question";
import { type JSX, Show } from "solid-js";
import { openFeedbackPage } from "../../../lib/feedback";
import { getLogger } from "../../../lib/logger";
import {
  newShowfile,
  promptForNewShowfile,
  saveShowfile,
} from "../../../lib/showfile-actions";
import { isTauriRuntime } from "../../../lib/tauri";
import { invokeTauriMenuAction } from "../../../lib/tauri-menu";
import { useAppShell } from "../../providers/app-shell";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubmenu,
} from "../../ui/dropdown-menu";
import { TOOLBAR_BUTTON_CLASS } from "../../ui/toolbar-button";

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
      triggerClass={props.triggerClass ?? TOOLBAR_BUTTON_CLASS}
      placement={props.placement}
      align={props.align}
      trigger={props.trigger}
    >
      <Show when={props.leadingItems !== undefined}>
        {props.leadingItems?.()}
        <DropdownMenuSeparator />
      </Show>
      <DropdownMenuItem
        icon={FilePlusIcon}
        shortcut="⌘⇧N"
        onClick={promptAndNewShowfile}
      >
        New Showfile
      </DropdownMenuItem>
      <DropdownMenuItem
        icon={FolderOpenIcon}
        shortcut="⌘O"
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
        shortcut="⌘S"
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
      <DropdownMenuItem icon={GearIcon} onClick={openSettings} shortcut="⌘,">
        Settings
      </DropdownMenuItem>
      <DropdownMenuItem
        icon={QuestionIcon}
        onClick={showShortcutsPopup}
        shortcut="⇧?"
      >
        <span data-guide-target="keyboard-shortcuts">Keyboard Shortcuts</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem icon={InfoIcon} onClick={openAbout}>
        About
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
    </DropdownMenu>
  );
}
