// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createMemo,
  createSignal,
  onCleanup,
  type ParentComponent,
  Show,
} from "solid-js";
import { $mappingMode, bindArmedSource } from "../../../features/io";
import { invokeBoundAction } from "../../../features/keybindings";
import { actionCatalog } from "../../../state/appStores";
import { ActionInputKind } from "../../../types";
import {
  $uiActions,
  CommandPaletteContext,
  type CommandPaletteContextType,
  registerUiAction,
  type UiAction,
  uiActionId,
  unregisterUiAction,
} from "../../providers/command-registry";
import { useShellOverlayCoordinator } from "../../providers/shell-overlay-coordinator";
import { CommandPaletteUI } from "./command-palette";
import OpenCommandPalette from "./commands/open-command-palette";

export const CommandPaletteProvider: ParentComponent = (props) => {
  const { closeOtherOverlays, registerOverlay } = useShellOverlayCoordinator();
  const commands = useStore($uiActions);
  const [isOpen, setIsOpen] = createSignal(false);
  const [selectedCommandId, setSelectedCommandId] = createSignal<string>();

  /** Registers a UI action in the shared registry with a default category. */
  const registerAction = (command: UiAction) => registerUiAction(command);

  /** Removes a UI action when its owning component unmounts or re-registers. */
  const unregisterAction = (id: string) => unregisterUiAction(id);

  const $backendCatalog = useStore(actionCatalog);
  const $mode = useStore($mappingMode);

  /**
   * Returns UI actions plus argument-free backend trigger actions for the palette.
   *
   * In controller mapping mode, choosing an entry binds the armed MIDI or OSC control to
   * it instead of running it.
   */
  const paletteEntries = createMemo<UiAction[]>(() => {
    const backendEntries = $backendCatalog()
      .filter(
        (entry) =>
          entry.descriptor.input === ActionInputKind.Trigger &&
          entry.descriptor.parameters.every((parameter) => !parameter.required),
      )
      .map((entry) => ({
        id: `action:${entry.descriptor.id}`,
        name: entry.descriptor.label,
        description: entry.descriptor.description,
        category: `Actions: ${entry.descriptor.category}`,
        reference: { id: entry.descriptor.id, arguments: {} },
        execute: () =>
          invokeBoundAction(
            { id: entry.descriptor.id, arguments: {} },
            { source: "palette" },
          ),
      }));
    const uiEntries = commands().map((command) => ({
      ...command,
      reference: { id: uiActionId(command), arguments: {} },
    }));
    return [...uiEntries, ...backendEntries].map(({ reference, ...entry }) =>
      $mode().active
        ? {
            ...entry,
            execute: () => {
              hidePalette();
              void bindArmedSource(reference, entry.name);
            },
          }
        : entry,
    );
  });

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
    registerAction,
    unregisterAction,
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
          commands={paletteEntries()}
          selectedCommandId={selectedCommandId()}
          onSelectedCommandIdChange={setSelectedCommandId}
        />
      </Show>
      <OpenCommandPalette />
    </CommandPaletteContext.Provider>
  );
};

// Command palette UI is now implemented in CommandPalette.tsx
