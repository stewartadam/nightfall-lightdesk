// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import { XIcon } from "@squidlab/phosphor-solid/x";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Show,
} from "solid-js";
import {
  allShortcuts,
  type KeyboardShortcut,
} from "../../../lib/keyboardShortcuts";
import { useAppShell } from "../../providers/app-shell";
import { Dialog, DialogBody } from "../../ui/dialog";
import { EmptyState } from "../../ui/empty-state";
import { Input, InputGroup } from "../../ui/form-controls";
import { HighlightedText } from "../../ui/highlighted-text";
import { Kbd, KbdShortcut } from "../../ui/kbd";
import { Button } from "../../ui/visual-language/button";
import {
  matchesShortcutSearch,
  mergeShortcutRows,
  shortcutSearchTerms,
} from "./shortcut-search";

/**
 * Component that displays all registered keyboard shortcuts in a popup
 * with multiple columns, filtered by a search field that matches each
 * shortcut's description, keys and group name
 */
export default function ShortcutsPopup() {
  const { dockviewApi, isShortcutsPopupVisible, hideShortcutsPopup } =
    useAppShell();
  const [query, setQuery] = createSignal("");
  let searchInput: HTMLInputElement | undefined;

  /** Empties the search and returns focus to the field so typing can continue. */
  const clearSearch = () => {
    setQuery("");
    searchInput?.focus();
  };

  /** Starts every opening of the dialog with the full, unfiltered list. */
  createEffect(() => {
    if (!isShortcutsPopupVisible()) setQuery("");
  });

  /** Resolve a human-friendly display name for a group key (panel id or component id) */
  const getDisplayName = (groupKey: string): string => {
    if (groupKey === "Global") return "Global";

    // Try to resolve via the dockview API (panels store titles there)
    try {
      const panel = dockviewApi()?.getPanel(groupKey as any);
      if (panel?.title) return panel.title as string;
    } catch (_e) {
      // ignore - getPanel may throw if id is not a panel id
    }

    // Final fallback to the raw group key
    return groupKey;
  };

  /** Lower-cased words of the search query, shared by filtering and highlighting. */
  const terms = createMemo(() => shortcutSearchTerms(query()));

  /**
   * Groups the shortcuts that match the search query by panel, sorted by key within each group
   * and merged into one row per action, with Global first and the remaining groups alphabetical.
   * Groups without matches are omitted.
   */
  const organizedShortcuts = createMemo(() => {
    const currentShortcuts = allShortcuts();
    const searchTerms = terms();
    const groups: Record<string, KeyboardShortcut[]> = {};

    for (const shortcut of currentShortcuts) {
      const groupKey = shortcut.group || shortcut.componentId || "Global";
      const searchable = {
        description: shortcut.description,
        key: shortcut.key,
        groupLabel: getDisplayName(groupKey),
      };
      if (!matchesShortcutSearch(searchTerms, searchable)) continue;
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(shortcut);
    }

    // Sort each group by key
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) =>
        a.key.localeCompare(b.key, undefined, { numeric: true }),
      );
    }

    // Ensure Global comes first
    const orderedGroups: [string, KeyboardShortcut[]][] = [];

    if (groups.Global) {
      orderedGroups.push(["Global", groups.Global]);
    }

    // Add other panels in alphabetical order
    for (const entry of Object.entries(groups)
      .filter(([key]) => key !== "Global")
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))) {
      orderedGroups.push(entry);
    }

    return orderedGroups.map(
      ([groupKey, shortcuts]) =>
        [groupKey, mergeShortcutRows(shortcuts)] as const,
    );
  });

  return (
    <Dialog
      kind="info"
      isOpen={isShortcutsPopupVisible()}
      title="Keyboard Shortcuts"
      onDismiss={hideShortcutsPopup}
      class="max-w-4xl"
      style={{ height: "80vh" }}
      backdropProps={
        {
          "data-dialog-kind": "shortcuts",
        } as JSX.DialogHtmlAttributes<HTMLDialogElement>
      }
    >
      <div class="shrink-0 px-4 pt-4">
        <InputGroup role="search">
          <MagnifyingGlassIcon
            class="ml-2 size-4 shrink-0 self-center text-neutral-400"
            aria-hidden
          />
          <Input
            type="search"
            class="w-full [&::-webkit-search-cancel-button]:hidden"
            ref={searchInput}
            autofocus
            aria-label="Search shortcuts"
            placeholder="Search by action, key or panel"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <Show when={query()}>
            <Button
              variant="subtle"
              size="icon"
              style={{ height: "auto" }}
              type="button"
              aria-label="Clear search"
              onClick={clearSearch}
            >
              <XIcon class="size-4" aria-hidden />
            </Button>
          </Show>
        </InputGroup>
      </div>
      <DialogBody role="region" aria-label="Keyboard shortcuts">
        <Show when={organizedShortcuts().length === 0}>
          <EmptyState
            variant="inline"
            align="center"
            class="py-8 justify-center"
            role="status"
            title={`No shortcuts match "${query().trim()}"`}
          />
        </Show>
        <div class="columns-1 md:columns-2 lg:columns-3 gap-8">
          <For each={organizedShortcuts()}>
            {([panelName, panelShortcuts]) => (
              <div class="mb-8 break-inside-avoid">
                <h3 class="text-sm font-semibold text-white mb-2 pb-1 border-b border-gray-600">
                  <HighlightedText
                    text={getDisplayName(panelName)}
                    terms={terms()}
                  />
                </h3>
                <div class="space-y-2">
                  <For each={panelShortcuts}>
                    {(row) => (
                      <div class="flex items-center text-sm gap-2">
                        <span class="flex shrink-0 flex-col items-start gap-1">
                          <For each={row.keys}>
                            {(key, index) => (
                              <span class="flex items-center gap-1">
                                <Show when={index() > 0}>
                                  <span class="text-xs text-neutral-500">
                                    or
                                  </span>
                                </Show>
                                <KbdShortcut shortcut={key} />
                              </span>
                            )}
                          </For>
                        </span>
                        <span class="min-w-0 flex-1 text-gray-300">
                          <HighlightedText
                            text={row.description}
                            terms={terms()}
                          />
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="mt-4 text-xs text-gray-500 text-center flex items-center justify-center gap-1">
          Press <Kbd keyName="Escape" /> to close
        </div>
      </DialogBody>
    </Dialog>
  );
}
