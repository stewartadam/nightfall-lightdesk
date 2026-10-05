// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { BookmarkIcon } from "@squidlab/phosphor-solid/bookmark";
import { LayoutIcon } from "@squidlab/phosphor-solid/layout";
import { QuestionIcon } from "@squidlab/phosphor-solid/question";
import { Show } from "solid-js";
import { compactViewport } from "../../../state/viewport";
import { useAppShell } from "../../providers/app-shell";
import { useCommand } from "../command-palette";

/** Registers commands that store or manage named arrangements of the docked workspace. */
function LayoutManagementCommands() {
  const { showLayoutManager } = useAppShell();

  useCommand({
    id: "manage-layouts",
    name: "Manage Layouts",
    description: "Create, save, rename, show, hide, and delete panel layouts",
    icon: LayoutIcon,
    category: "Layout",
    execute: showLayoutManager,
  });
  useCommand({
    id: "store-current-layout",
    name: "Store Current Layout",
    description:
      "Open layout management with controls for storing the current panel layout",
    icon: BookmarkIcon,
    category: "Layout",
    execute: showLayoutManager,
  });

  return null;
}

/**
 * Registers commands owned by Dockview layout management and shortcut discovery.
 * Layout management is withheld from the compact shell, whose one-panel view
 * must never be stored over a docked arrangement.
 */
export default function LayoutCommands() {
  const { showShortcutsPopup } = useAppShell();
  const compact = useStore(compactViewport);

  useCommand({
    id: "show-keyboard-shortcuts",
    name: "Show Keyboard Shortcuts",
    description: "Show all available keyboard shortcuts",
    shortcut: "Shift+?",
    shortcutOptions: { capture: true },
    icon: QuestionIcon,
    execute: showShortcutsPopup,
  });

  return (
    <Show when={!compact()}>
      <LayoutManagementCommands />
    </Show>
  );
}
