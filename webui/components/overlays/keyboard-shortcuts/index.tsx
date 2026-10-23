// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  Show,
  untrack,
} from "solid-js";
import { getFocusedComponentId } from "../../../lib/componentFocusContext";
import {
  allShortcuts,
  type KeyboardShortcut,
} from "../../../lib/keyboardShortcuts";
import {
  findPanelDefinitionById,
  findPanelDefinitionByName,
} from "../../../lib/panel-definitions";
import { useAppShell } from "../../providers/app-shell";
import { Badge } from "../../ui/badge";
import { Dialog, DialogBody } from "../../ui/dialog";
import { EmptyState } from "../../ui/empty-state";
import { HighlightedText } from "../../ui/highlighted-text";
import { Kbd, KbdShortcut } from "../../ui/kbd";
import { SearchField } from "../../ui/search-field";
import { searchTerms } from "../../ui/search-match";
import { GLOBAL_GROUP, groupShortcuts } from "./shortcut-groups";
import { matchesShortcutSearch } from "./shortcut-search";

/**
 * Component that displays all registered keyboard shortcuts in a popup
 * with multiple columns, filtered by a search field that matches each
 * shortcut's description, keys and group name
 */
export default function ShortcutsPopup() {
  const { dockviewApi, isShortcutsPopupVisible, hideShortcutsPopup } =
    useAppShell();
  const [query, setQuery] = createSignal("");

  const [activeComponentId, setActiveComponentId] = createSignal<string | null>(
    null,
  );

  /**
   * Starts every opening of the dialog with the full, unfiltered list, and remembers which panel
   * was active when it opened so that panel's shortcuts can be listed first.
   */
  createEffect(() => {
    if (isShortcutsPopupVisible()) {
      setActiveComponentId(
        untrack(
          () =>
            getFocusedComponentId() ?? dockviewApi()?.activePanel?.id ?? null,
        ),
      );
    } else {
      setQuery("");
    }
  });

  /**
   * Names the group a shortcut is listed under: its explicit group, else the type of the panel
   * that registered it (so every open Timelines panel shares "Timelines"), else Global.
   */
  const groupLabel = (shortcut: KeyboardShortcut): string => {
    if (shortcut.group) return shortcut.group;
    const componentId = shortcut.componentId;
    if (!componentId) return GLOBAL_GROUP;
    const definition =
      findPanelDefinitionById(componentId) ??
      findPanelDefinitionByName(
        dockviewApi()?.getPanel(componentId)?.api.component ?? "",
      );
    return definition?.title ?? componentId;
  };

  /** Lower-cased words of the search query, shared by filtering and highlighting. */
  const terms = createMemo(() => searchTerms(query()));

  /**
   * Groups the shortcuts that match the search query by panel type, with Global first and the
   * active panel's type next. Groups without matches are omitted.
   */
  const organizedShortcuts = createMemo(() => {
    const searchTermList = terms();
    const matching = allShortcuts().filter((shortcut) =>
      matchesShortcutSearch(searchTermList, {
        description: shortcut.description,
        key: shortcut.key,
        groupLabel: groupLabel(shortcut),
      }),
    );
    return groupShortcuts(matching, groupLabel, activeComponentId());
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
        <SearchField
          label="Search shortcuts"
          placeholder="Search by action, key or panel"
          autofocus
          value={query()}
          onInput={setQuery}
        />
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
          <Index each={organizedShortcuts()}>
            {(group) => (
              <div class="mb-8 break-inside-avoid">
                <h3 class="flex items-center gap-2 text-sm font-semibold text-white mb-2 pb-1 border-b border-gray-600">
                  <HighlightedText text={group().label} terms={terms()} />
                  <Show when={group().active}>
                    <Badge size="xs" appearance="soft" tone="accent">
                      Active panel
                    </Badge>
                  </Show>
                </h3>
                <div class="space-y-2">
                  <Index each={group().rows}>
                    {(row) => (
                      <div class="flex items-center text-sm gap-2">
                        <span class="flex shrink-0 flex-col items-start gap-1">
                          <For each={row().keys}>
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
                            text={row().description}
                            terms={terms()}
                          />
                        </span>
                      </div>
                    )}
                  </Index>
                </div>
              </div>
            )}
          </Index>
        </div>

        <div class="mt-4 text-xs text-gray-500 text-center flex items-center justify-center gap-1">
          Press <Kbd keyName="Escape" /> to close
        </div>
      </DialogBody>
    </Dialog>
  );
}
