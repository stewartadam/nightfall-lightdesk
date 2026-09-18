// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { BookmarkIcon } from "@squidlab/phosphor-solid/bookmark";
import { LayoutIcon } from "@squidlab/phosphor-solid/layout";
import { QuestionIcon } from "@squidlab/phosphor-solid/question";
import { useAppShell } from "../../providers/app-shell";
import { useCommand } from "../command-palette";

/** Registers commands owned by Dockview layout management and shortcut discovery. */
export default function LayoutCommands() {
  const { showLayoutManager, showShortcutsPopup } = useAppShell();

  useCommand({
    id: "show-keyboard-shortcuts",
    name: "Show Keyboard Shortcuts",
    description: "Show all available keyboard shortcuts",
    shortcut: "Shift+?",
    shortcutOptions: { capture: true },
    icon: QuestionIcon,
    execute: showShortcutsPopup,
  });
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
