// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { KeyboardShortcutOptions } from "../../../lib/keyboardShortcuts";
import type { AppIcon } from "../../ui/icon";

interface CommandExecutionContext {
  source: "palette" | "shortcut";
  event?: KeyboardEvent | MouseEvent;
}

export interface CommandAction {
  id: string;
  name: string;
  description?: string;
  shortcut?: string;
  shortcutAliases?: string[];
  shortcutOptions?: KeyboardShortcutOptions;
  icon?: AppIcon;
  execute: (context?: CommandExecutionContext) => void;
  category?: string;
}

export interface CommandPaletteContextType {
  registerCommand: (command: CommandAction) => () => void;
  unregisterCommand: (id: string) => void;
  showPalette: () => void;
  hidePalette: () => void;
  isOpen: () => boolean;
}

/**
 * Returns every keyboard shortcut that should execute a command.
 */
export function getCommandShortcutKeys(command: CommandAction): string[] {
  const shortcutKeys = [
    ...(command.shortcut ? [command.shortcut] : []),
    ...(command.shortcutAliases ?? []),
  ];

  return [...new Set(shortcutKeys)];
}

export const DEFAULT_CATEGORY = "General";
