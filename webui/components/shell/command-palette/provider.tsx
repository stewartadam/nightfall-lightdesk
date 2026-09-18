// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, onCleanup, type ParentComponent, Show } from "solid-js";
import {
  type CommandAction,
  CommandPaletteContext,
  type CommandPaletteContextType,
  DEFAULT_CATEGORY,
} from "../../providers/command-registry";
import { useShellOverlayCoordinator } from "../../providers/shell-overlay-coordinator";
import { CommandPaletteUI } from "./command-palette";
import OpenCommandPalette from "./commands/open-command-palette";

export const CommandPaletteProvider: ParentComponent = (props) => {
  const { closeOtherOverlays, registerOverlay } = useShellOverlayCoordinator();
  const [commands, setCommands] = createSignal<CommandAction[]>([]);
  const [isOpen, setIsOpen] = createSignal(false);
  const [selectedCommandId, setSelectedCommandId] = createSignal<string>();

  /** Add commands with a default category and return the unsubscriber used on cleanup. */
  const registerCommand = (command: CommandAction) => {
    const newCommand = {
      ...command,
      category: command.category || DEFAULT_CATEGORY,
    };

    setCommands((prev) => [...prev, newCommand]);

    return () => unregisterCommand(command.id);
  };

  /** Remove a command when its owning component unmounts or re-registers. */
  const unregisterCommand = (id: string) => {
    setCommands((prev) => prev.filter((cmd) => cmd.id !== id));
  };

  /** Opens the command palette after closing other transient shell overlays. */
  const showPalette = () => {
    closeOtherOverlays("commandPalette");
    setIsOpen(true);
  };

  /** Closes the command palette without affecting other shell overlays. */
  const hidePalette = () => {
    setIsOpen(false);
  };

  onCleanup(registerOverlay("commandPalette", hidePalette));

  const contextValue: CommandPaletteContextType = {
    registerCommand,
    unregisterCommand,
    showPalette,
    hidePalette,
    isOpen,
  };

  // Expose a simple global helper to allow non-Solid UI (header.hbs) to open the
  // command palette. This keeps the header template simple and avoids coupling
  // Handlebars to Solid internals.
  try {
    (window as any).nightfallShowPalette = showPalette;
  } catch (_e) {
    // no-op in environments where window is not available
  }

  return (
    <CommandPaletteContext.Provider value={contextValue}>
      {props.children}
      <Show when={isOpen()}>
        <CommandPaletteUI
          isOpen={isOpen()}
          onClose={hidePalette}
          commands={commands()}
          selectedCommandId={selectedCommandId()}
          onSelectedCommandIdChange={setSelectedCommandId}
        />
      </Show>
      <OpenCommandPalette />
    </CommandPaletteContext.Provider>
  );
};

// Command palette UI is now implemented in CommandPalette.tsx
