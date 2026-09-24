// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { KeyboardShortcutOptions } from "../../../lib/keyboardShortcuts";
import type { AppIcon } from "../../ui/icon";

/** Describes what invoked a UI action. */
export interface UiActionExecutionContext {
  /** Surface that invoked the action. */
  source: "palette" | "shortcut" | "keybinding" | "midi" | "osc";
  /** Originating DOM event, when the action was invoked from the browser. */
  event?: KeyboardEvent | MouseEvent;
}

export interface UiAction {
  id: string;
  name: string;
  description?: string;
  shortcut?: string;
  shortcutAliases?: string[];
  shortcutOptions?: KeyboardShortcutOptions;
  icon?: AppIcon;
  execute: (context?: UiActionExecutionContext) => void;
  category?: string;
}

export interface CommandPaletteContextType {
  registerAction: (command: UiAction) => () => void;
  unregisterAction: (id: string) => void;
  showPalette: () => void;
  hidePalette: () => void;
  isOpen: () => boolean;
}

/**
 * Returns every keyboard shortcut that should execute a command.
 */
export function getCommandShortcutKeys(command: UiAction): string[] {
  const shortcutKeys = [
    ...(command.shortcut ? [command.shortcut] : []),
    ...(command.shortcutAliases ?? []),
  ];

  return [...new Set(shortcutKeys)];
}

export const DEFAULT_CATEGORY = "General";
