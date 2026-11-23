// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import { createEffect } from "../../../lib/solid-compat";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { getCommandShortcutKeys, type UiAction } from "./command-types";
import { useCommandPalette } from "./context";

const log = getLogger(import.meta.url);

/**
 * Registers a palette command and its optional global shortcut for this component.
 */
export function useUiAction(command: UiAction) {
  const workspaceActive = useWorkspaceActivity();
  log.trace("mounting");
  const { registerAction } = useCommandPalette();

  /** Lists the command in the palette only while this component's workspace is active. */
  createEffect(workspaceActive, (active) => {
    if (!active) return;
    const unregister = registerAction(command);
    return () => {
      log.trace("unmounting");
      unregister();
    };
  });

  // Shortcuts gate themselves on workspace activity.
  for (const shortcut of getCommandShortcutKeys(command)) {
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

  return {
    execute: command.execute,
  };
}
