// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** biome-ignore-all lint/a11y/noSvgWithoutTitle: the actual command label is adjacent to the icon */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { CaretUpIcon } from "@squidlab/phosphor-solid/caret-up";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  isPaletteNavigationKey,
  nextPaletteIndex,
  visiblePaletteRowCount,
} from "../../../lib/palette-navigation";
import {
  type PanelOpenModifierState,
  panelOpenPlacementFromModifiers,
  panelOpenPlacementLabel,
} from "../../../lib/panel-open-command";
import type { CommandAction } from "../../providers/command-registry";
import { DialogBackdrop } from "../../ui/dialog";
import { MenuHeading } from "../../ui/menu";
import {
  SearchPickerInput,
  SearchPickerOption,
  SearchPickerSurface,
} from "../../ui/search-picker";
import {
  groupCommandPaletteCommands,
  rankCommandPaletteCommands,
} from "./command-search";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: CommandAction[];
  selectedCommandId?: string;
  onSelectedCommandIdChange: (id: string) => void;
}

const CommandPaletteUI: Component<CommandPaletteProps> = (props) => {
  const [search, setSearch] = createSignal("");
  const [lastSelectionQuery, setLastSelectionQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [filteredCommands, setFilteredCommands] = createSignal<CommandAction[]>(
    [],
  );
  const [canScrollDown, setCanScrollDown] = createSignal(false);
  const [canScrollUp, setCanScrollUp] = createSignal(false);
  const [modifierState, setModifierState] =
    createSignal<PanelOpenModifierState>({});
  let inputRef: HTMLInputElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let scrollContainerRef: HTMLDivElement | undefined;

  /** Filters commands based on the current search input. */
  createEffect(() => {
    const allCommands = props.commands || [];
    setFilteredCommands(rankCommandPaletteCommands(allCommands, search()));
  });

  /** Selects a command by visible index and records its id for later list updates. */
  const selectCommandAtIndex = (
    commands: readonly CommandAction[],
    index: number,
  ) => {
    const command = commands[index];
    if (!command) return;

    setSelectedIndex(index);
    props.onSelectedCommandIdChange(command.id);
  };

  /** Captures modifier keys used to preview alternate panel placement. */
  const updateModifierState = (event: KeyboardEvent | MouseEvent) => {
    setModifierState({
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
  };

  /** Updates whether the command list has more hidden rows above or below. */
  const updateScrollOverflow = () => {
    const scrollContainer = scrollContainerRef;
    if (!scrollContainer) return;

    const maxScrollTop = Math.max(
      0,
      scrollContainer.scrollHeight - scrollContainer.clientHeight,
    );
    setCanScrollUp(scrollContainer.scrollTop > 1);
    setCanScrollDown(scrollContainer.scrollTop < maxScrollTop - 1);
  };

  /** Positions the selected command as the second visible command row when possible. */
  const positionSelectedCommand = (index: number) => {
    requestAnimationFrame(() => {
      const scrollContainer = scrollContainerRef;
      if (!scrollContainer) return;

      const selectedElement = scrollContainer.querySelector<HTMLElement>(
        `[data-command-index="${index}"]`,
      );
      if (!selectedElement) {
        updateScrollOverflow();
        return;
      }

      const parentList = selectedElement.parentElement;
      const categoryHeader =
        parentList?.firstElementChild === selectedElement
          ? (parentList.previousElementSibling as HTMLElement | null)
          : undefined;
      const previousElement = scrollContainer.querySelector<HTMLElement>(
        `[data-command-index="${index - 1}"]`,
      );
      const anchorElement =
        categoryHeader ?? previousElement ?? selectedElement;
      const maxScrollTop = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight,
      );
      const targetScrollTop = Math.min(
        Math.max(anchorElement.offsetTop, 0),
        maxScrollTop,
      );

      scrollContainer.scrollTop = targetScrollTop;
      updateScrollOverflow();
    });
  };

  /**
   * Direct keyboard event handler for command palette navigation
   *
   * NOTE: This component uses direct DOM event listeners rather than the keyboard shortcuts system for the following reasons:
   * 1. The palette is a temporary overlay that needs fine-grained control over event propagation
   * 2. This UI pattern is modal and temporarily captures all keyboard input while open
   * 3. These keyboard actions are specific to navigating the command list, not application shortcuts
   *
   * The keys handled here (ArrowUp/ArrowDown/Enter/Escape) are standard for accessible dropdown
   * and list navigation patterns.
   *
   * @param e - The keyboard event
   */
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!props.isOpen) return;
    updateModifierState(e);

    // Handle Escape immediately, even if there are no commands (e.g., no search results)
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }

    const cmds = flattenedCommands();
    if (cmds.length === 0) return;

    // Only handle navigation keys and submit
    if (!isPaletteNavigationKey(e.key) && e.key !== "Enter") {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const currentIndex = selectedIndex();
    let newIndex = currentIndex;

    if (isPaletteNavigationKey(e.key)) {
      const selectedElement = scrollContainerRef?.querySelector<HTMLElement>(
        `[data-command-index="${currentIndex}"]`,
      );
      const pageSize = visiblePaletteRowCount(
        scrollContainerRef,
        selectedElement ?? undefined,
      );
      newIndex = nextPaletteIndex(currentIndex, cmds.length, e.key, pageSize);
      selectCommandAtIndex(cmds, newIndex);
      return;
    }

    switch (e.key) {
      case "Enter": {
        e.preventDefault();
        const selectedCommand = flattenedCommands()[selectedIndex()];
        if (selectedCommand) {
          props.onSelectedCommandIdChange(selectedCommand.id);
          selectedCommand.execute({ source: "palette", event: e });
          props.onClose();
        }
        break;
      }
    }
  };

  /** Refreshes modifier-preview state as modifier keys are released. */
  const handleKeyUp = (e: KeyboardEvent) => {
    if (!props.isOpen) return;
    updateModifierState(e);
  };

  /**
   * Set up and clean up keyboard event listeners
   *
   * We register a global event listener while the command palette is open to ensure
   * we capture all keyboard events regardless of which element has focus.
   */

  /** Focuses and clears the search input each time the palette opens. */
  createEffect(() => {
    if (props.isOpen) {
      setTimeout(() => {
        inputRef?.focus();
        inputRef?.select();
      }, 0);
      setSearch("");
      setModifierState({});
    } else {
      setModifierState({});
    }
  });

  /** Repositions the command list whenever the selected row changes. */
  createEffect(() => {
    const index = selectedIndex();
    const commands = flattenedCommands();
    if (index >= 0 && index < commands.length) {
      positionSelectedCommand(index);
    }
  });

  /** Selects the best result for new queries while preserving explicit navigation. */
  createEffect(() => {
    const cmds = flattenedCommands();
    const query = search().trim();
    if (cmds.length === 0) {
      setLastSelectionQuery(query);
      setCanScrollDown(false);
      setCanScrollUp(false);
      return;
    }

    if (query !== untrack(lastSelectionQuery)) {
      setLastSelectionQuery(query);
      if (query.length > 0) {
        selectCommandAtIndex(cmds, 0);
        return;
      }
    }

    const selectedId = props.selectedCommandId;
    const selectedIdIndex = selectedId
      ? cmds.findIndex((cmd) => cmd.id === selectedId)
      : -1;

    if (selectedIdIndex >= 0) {
      if (untrack(selectedIndex) !== selectedIdIndex) {
        setSelectedIndex(selectedIdIndex);
      }
      return;
    }

    const fallbackIndex = Math.min(
      Math.max(untrack(selectedIndex), 0),
      cmds.length - 1,
    );
    selectCommandAtIndex(cmds, fallbackIndex);
  });

  /** Close when clicking outside */
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      props.onClose();
    }
  };

  /** Helper to get all commands as a flat list */
  const getFlattenedCommands = () => {
    return commandGroups().flatMap((group) => group.commands);
  };

  /** Groups commands while preserving ranked result order during search. */
  const commandGroups = createMemo(() =>
    groupCommandPaletteCommands(filteredCommands(), search().trim().length > 0),
  );

  const isMac =
    typeof navigator !== "undefined"
      ? navigator.platform.includes("Mac")
      : false;

  /** Helper to check if a command is selected by stable id. */
  const isSelected = (command: CommandAction) =>
    command.id === props.selectedCommandId;

  /** Returns whether a command opens a dockable panel. */
  const isPanelCommand = (command: CommandAction) =>
    command.category === "Panels";

  /** The active panel-placement badge shown while modifier keys are held. */
  const placementBadgeLabel = createMemo(() =>
    panelOpenPlacementLabel(panelOpenPlacementFromModifiers(modifierState())),
  );

  /** Memoized flattened commands for selection */
  const flattenedCommands = createMemo(() => getFlattenedCommands());

  /** Returns the currently highlighted command, if one exists. */
  const selectedCommand = createMemo(
    () => flattenedCommands()[selectedIndex()],
  );

  /** Returns the search-bar placement label for selected panel commands. */
  const selectedPanelPlacementLabel = createMemo(() => {
    const command = selectedCommand();
    if (!command || !isPanelCommand(command)) return undefined;
    return placementBadgeLabel();
  });

  /** Create a map of command to its global index */
  const commandToGlobalIndex = createMemo(() => {
    const map = new Map<CommandAction, number>();
    const cmds = flattenedCommands();
    for (const cmd of cmds) {
      map.set(cmd, cmds.indexOf(cmd));
    }
    return map;
  });

  return (
    <DialogBackdrop
      style={{ "align-items": "flex-start", "padding-top": "80px" }}
      data-dialog-kind="command-palette"
      data-dialog-visible="true"
      on:keydown={{ handleEvent: handleKeyDown, capture: true }}
      on:keyup={{ handleEvent: handleKeyUp, capture: true }}
      on:mousemove={(event) => updateModifierState(event)}
      on:mousedown={{ handleEvent: handleClickOutside, capture: true }}
    >
      <SearchPickerSurface
        ref={containerRef}
        class="max-w-2xl"
        style={{
          "max-height":
            "calc(100dvh - var(--guide-overlay-bottom, 0px) - 96px)",
        }}
      >
        <SearchPickerInput
          ref={inputRef}
          type="text"
          placeholder="Type a command or search..."
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          trailing={
            <div class="flex shrink-0 items-center gap-2">
              <Show
                fallback={
                  <div
                    data-command-shortcut-hint
                    class="flex items-center gap-2"
                  >
                    <kbd class="px-2 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-600 rounded">
                      {isMac ? "⌘" : "Ctrl"}+K
                    </kbd>
                    <span class="text-sm text-gray-400">to open</span>
                  </div>
                }
                when={selectedPanelPlacementLabel()}
              >
                {(label) => (
                  <span
                    class="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 dark:border-blue-500/60 dark:bg-blue-950/70 dark:text-blue-200"
                    data-panel-placement-badge="true"
                  >
                    {label()}
                  </span>
                )}
              </Show>
            </div>
          }
        />

        <div class="relative min-h-0 flex flex-col">
          <Show when={canScrollUp()}>
            <div
              aria-hidden="true"
              class="pointer-events-none absolute top-0 left-0 right-0 z-10 flex h-6 items-center justify-center bg-white text-gray-600 shadow-[0_10px_18px_rgba(15,23,42,0.34)] dark:bg-gray-800 dark:text-gray-300 dark:shadow-[0_10px_18px_rgba(0,0,0,0.7)]"
              data-scroll-overflow="top"
            >
              <CaretUpIcon class="size-4" aria-hidden />
            </div>
          </Show>
          <div
            ref={scrollContainerRef}
            class="min-h-0 max-h-[32rem] overflow-y-auto"
            data-command-scroll-area="true"
            onScroll={updateScrollOverflow}
          >
            <Show
              when={filteredCommands().length > 0}
              fallback={
                <div class="px-6 py-12 text-center">
                  <svg
                    class="mx-auto h-12 w-12 text-gray-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="1"
                      d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <h3 class="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                    No commands found
                  </h3>
                  <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Try a different search term, or press <code>Escape</code> to
                    dismiss
                  </p>
                </div>
              }
            >
              <ul>
                <For each={commandGroups()}>
                  {(group) => (
                    <li class="border-b border-gray-100 dark:border-gray-700">
                      <MenuHeading data-command-category-title={group.category}>
                        {group.category}
                      </MenuHeading>
                      <ul>
                        <For each={group.commands}>
                          {(cmd) => {
                            const globalIndex = () =>
                              commandToGlobalIndex().get(cmd) ?? -1;
                            const selected = createMemo(() => isSelected(cmd));
                            return (
                              <li
                                data-command-id={cmd.id}
                                data-command-index={globalIndex()}
                                data-selected={selected()}
                                class="command-item"
                              >
                                <SearchPickerOption
                                  selected={selected()}
                                  onMouseDown={(event) =>
                                    event.preventDefault()
                                  }
                                  onClick={(event) => {
                                    selectCommandAtIndex(
                                      flattenedCommands(),
                                      globalIndex(),
                                    );
                                    cmd.execute({ source: "palette", event });
                                    props.onClose();
                                  }}
                                >
                                  <div class="flex items-center">
                                    <div class="mr-3 text-gray-400 w-[24px] h-[24px]">
                                      <Show when={cmd.icon}>
                                        {(CommandIcon) => (
                                          <Dynamic
                                            component={CommandIcon()}
                                            class="size-6"
                                            aria-hidden
                                          />
                                        )}
                                      </Show>
                                    </div>
                                    <div>
                                      <div class="font-medium text-gray-900 dark:text-gray-100">
                                        {cmd.name}
                                      </div>
                                      <Show when={cmd.description}>
                                        <div class="text-sm text-gray-500 dark:text-gray-400">
                                          {cmd.description}
                                        </div>
                                      </Show>
                                    </div>
                                  </div>
                                  <div class="ml-3 flex shrink-0 items-center gap-2">
                                    <Show when={cmd.shortcut}>
                                      <kbd class="px-2 py-1 text-xs font-mono text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded">
                                        {cmd.shortcut?.replace(
                                          "mod",
                                          isMac ? "⌘" : "Ctrl",
                                        )}
                                      </kbd>
                                    </Show>
                                  </div>
                                </SearchPickerOption>
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
          <Show when={canScrollDown()}>
            <div
              aria-hidden="true"
              class="pointer-events-none absolute bottom-0 left-0 right-0 z-10 flex h-6 items-center justify-center bg-white text-gray-600 shadow-[0_-10px_18px_rgba(15,23,42,0.26)] dark:bg-gray-800 dark:text-gray-300 dark:shadow-[0_-10px_18px_rgba(0,0,0,0.6)]"
              data-scroll-overflow="bottom"
            >
              <CaretDownIcon class="size-4" aria-hidden />
            </div>
          </Show>
        </div>
      </SearchPickerSurface>
    </DialogBackdrop>
  );
};

export { CommandPaletteUI };
