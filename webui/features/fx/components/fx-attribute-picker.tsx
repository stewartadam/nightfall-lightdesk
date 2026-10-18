// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Input } from "../../../components/ui/form-controls";
import {
  MenuItem,
  MenuSeparator,
  MenuSurface,
} from "../../../components/ui/menu";
import { Popover } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Button } from "../../../components/ui/visual-language/button";

/** Default common fixture attributes available for FX animation. Components
 * may provide a dynamic `availableAttributes` prop (derived from selected
 * fixtures' parameter metadata) and this constant will be used as a fallback
 * when none is supplied. */
const DEFAULT_AVAILABLE_ATTRIBUTES = [
  "Intensity",
  "Pan",
  "Tilt",
  "Red",
  "Green",
  "Blue",
  "White",
] as const;

export interface FxAttributePickerProps {
  /** Currently selected attribute names */
  selectedAttributes: string[];
  /** Callback when attribute selection changes */
  onChange: (attrs: string[]) => void;
  /** Whether to render selected attributes as removable tags. */
  showSelectedAttributes?: boolean;
  /** Whether to render the visible picker heading above its controls. */
  showLabel?: boolean;
  /** Optional list of attribute names to display (preferred). If omitted the
   * component falls back to `DEFAULT_AVAILABLE_ATTRIBUTES`. */
  availableAttributes?: string[];
  /** Monotonic request token that opens, focuses, and selects the search field. */
  focusSearchRequest?: number;
  /** Monotonic request token that dismisses and clears the search menu. */
  dismissRequest?: number;
}

/**
 * Attribute picker component for selecting which fixture attributes
 * an FX should animate. Displays optional removable tags and a searchable,
 * checkable menu for changing the active attributes. The menu is a shared
 * `Popover` anchored to the picker, so scrolling panels never clip it and
 * toggling an attribute keeps it open for further choices.
 */
export function FxAttributePicker(props: FxAttributePickerProps) {
  const [isDropdownOpen, setIsDropdownOpen] = createSignal(false);
  const [searchTerm, setSearchTerm] = createSignal("");
  let rootRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  let addButtonRef: HTMLButtonElement | undefined;
  let suppressFocusOpen = false;

  /** Reports whether the search field sits inline in place of tags and an add button. */
  const inlineSearch = () => props.showSelectedAttributes === false;

  /** Dismisses the attribute menu and clears its transient search query. */
  const dismiss = (): void => {
    setIsDropdownOpen(false);
    setSearchTerm("");
  };

  /**
   * Picks where focus returns after Escape: the add button, or the inline
   * search field without letting that focus reopen the menu.
   */
  const returnFocus = (): HTMLElement | undefined => {
    if (!inlineSearch()) return addButtonRef;
    suppressFocusOpen = true;
    queueMicrotask(() => {
      suppressFocusOpen = false;
    });
    return searchInputRef;
  };

  /** Indexes the selected names for menu state and toggle operations. */
  const selectedSet = createMemo(() => new Set(props.selectedAttributes));

  /** Returns the deduplicated attribute catalog available to the picker. */
  const allAttributes = createMemo(() => {
    const source = props.availableAttributes ?? DEFAULT_AVAILABLE_ATTRIBUTES;
    const deduped = new Set<string>();
    for (const attr of props.selectedAttributes) {
      if (attr.trim()) deduped.add(attr);
    }
    for (const attr of source) {
      if (!attr.trim()) continue;
      deduped.add(attr);
    }
    return Array.from(deduped).sort((left, right) => left.localeCompare(right));
  });

  /** Filters the complete catalog without hiding already selected attributes. */
  const filteredAttributes = createMemo(() => {
    const query = searchTerm().trim().toLowerCase();
    return allAttributes().filter(
      (attr) => query.length === 0 || attr.toLowerCase().includes(query),
    );
  });

  /** Removes one selected attribute from the controlled value. */
  const removeAttribute = (attr: string) => {
    props.onChange(props.selectedAttributes.filter((a) => a !== attr));
  };

  /** Toggles one checkable menu item without closing the picker. */
  const toggleAttribute = (attr: string): void => {
    if (selectedSet().has(attr)) {
      removeAttribute(attr);
      return;
    }
    props.onChange([...props.selectedAttributes, attr]);
  };

  /** Moves focus into the active search field whenever the menu opens. */
  createEffect(() => {
    if (isDropdownOpen()) {
      queueMicrotask(() => {
        searchInputRef?.focus();
      });
    }
  });

  /** Opens and selects search text in response to an editor shortcut request. */
  createEffect(() => {
    const request = props.focusSearchRequest;
    if (!request) return;
    setIsDropdownOpen(true);
    queueMicrotask(() => {
      searchInputRef?.focus();
      searchInputRef?.select();
    });
  });

  /** Dismisses the menu when its owning editor handles Escape elsewhere. */
  createEffect(() => {
    const request = props.dismissRequest;
    if (!request) return;
    dismiss();
  });

  return (
    <div class="flex flex-col gap-2">
      <Show when={props.showLabel !== false}>
        <label class="text-xs text-neutral-400">Attributes</label>
      </Show>
      <div ref={rootRef}>
        <div
          class="flex flex-wrap items-center gap-1"
          classList={{
            "min-h-10 rounded-md border border-neutral-700 bg-neutral-900/40 p-1.5":
              !inlineSearch(),
          }}
        >
          <Show when={!inlineSearch()}>
            <For each={props.selectedAttributes}>
              {(attr) => (
                <Button
                  size="compact"
                  type="button"
                  onClick={() => removeAttribute(attr)}
                  variant="primary"
                  class="items-center gap-1"
                  title={`Remove ${attr}`}
                >
                  <span>{attr}</span>
                  <span aria-hidden="true" class="text-blue-200">
                    ×
                  </span>
                </Button>
              )}
            </For>

            <Show when={props.selectedAttributes.length === 0}>
              <span class="px-1 text-xs text-neutral-500">
                No attributes selected
              </span>
            </Show>
          </Show>

          <Show
            when={!inlineSearch()}
            fallback={
              <Input
                density="compact"
                ref={searchInputRef}
                type="search"
                aria-label="Search attributes"
                aria-expanded={isDropdownOpen()}
                aria-haspopup="menu"
                value={searchTerm()}
                onFocus={() => {
                  if (!suppressFocusOpen) setIsDropdownOpen(true);
                }}
                onClick={() => setIsDropdownOpen(true)}
                onInput={(event) => {
                  setSearchTerm(event.currentTarget.value);
                  setIsDropdownOpen(true);
                }}
                placeholder="Search attributes..."
                class="w-full"
              />
            }
          >
            <Button
              ref={addButtonRef}
              size="compact"
              type="button"
              onClick={() =>
                isDropdownOpen() ? dismiss() : setIsDropdownOpen(true)
              }
              class="ml-auto items-center gap-1"
              aria-expanded={isDropdownOpen()}
              aria-haspopup="menu"
            >
              Add attribute
            </Button>
          </Show>
        </div>

        <Popover
          anchor={() => rootRef}
          open={isDropdownOpen()}
          onClose={dismiss}
          placement="auto"
          matchAnchorWidth
          initialFocus="none"
          returnFocus={returnFocus}
          surface={MenuSurface}
          class="flex flex-col"
          data-fx-attribute-picker-menu
        >
          <Show when={!inlineSearch()}>
            <Input
              density="compact"
              ref={searchInputRef}
              type="search"
              aria-label="Search attributes"
              value={searchTerm()}
              onInput={(event) => setSearchTerm(event.currentTarget.value)}
              placeholder="Search attributes..."
              class="w-full"
            />
            <MenuSeparator />
          </Show>

          <ScrollArea
            class="min-h-0 max-h-52"
            viewportProps={{ role: "menu", "aria-label": "Attributes" }}
          >
            <Show
              when={filteredAttributes().length > 0}
              fallback={
                <div class="px-2 py-2 text-xs text-neutral-500">
                  No matching attributes
                </div>
              }
            >
              <For each={filteredAttributes()}>
                {(attr) => (
                  <MenuItem
                    role="menuitemcheckbox"
                    aria-checked={selectedSet().has(attr)}
                    checked={selectedSet().has(attr)}
                    onClick={() => toggleAttribute(attr)}
                  >
                    {attr}
                  </MenuItem>
                )}
              </For>
            </Show>
          </ScrollArea>
        </Popover>
      </div>
    </div>
  );
}
