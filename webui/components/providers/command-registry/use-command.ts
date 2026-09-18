// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, onCleanup, untrack } from "solid-js";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { type CommandAction, getCommandShortcutKeys } from "./command-types";
import { useCommandPalette } from "./context";

const log = getLogger(import.meta.url);

/**
 * Registers a palette command and its optional global shortcut for this component.
 */
export function useCommand(command: CommandAction) {
  const workspaceActive = useWorkspaceActivity();
  log.trace("mounting");
  const { registerCommand } = useCommandPalette();

  // Keep palette registration scoped to this component's reactive lifetime.
  createEffect(() => {
    if (!workspaceActive()) return;
    const unregister = untrack(() => registerCommand(command));

    const shortcutKeys = getCommandShortcutKeys(command);

    // Register keyboard shortcuts if provided
    for (const shortcut of shortcutKeys) {
      log.debug("Registering keyboard shortcut for command:", command.name);
      useKeyboardShortcut(
        {
          key: shortcut,
          handler: (e?: KeyboardEvent) => {
            if (e) e.preventDefault();
            command.execute({ source: "shortcut", event: e });
          },
          description: command.description || `Execute ${command.name}`,
        },
        { global: true, ...command.shortcutOptions },
      );
    }

    // Clean up when the component unmounts
    onCleanup(() => {
      log.trace("unmounting");
      unregister();
    });
  });

  return {
    execute: command.execute,
  };
}
