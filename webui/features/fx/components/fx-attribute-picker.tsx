// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CheckIcon } from "@squidlab/phosphor-solid/check";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Input } from "../../../components/ui/form-controls";
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
 * checkable menu for changing the active attributes.
 */
export function FxAttributePicker(props: FxAttributePickerProps) {
  const [isDropdownOpen, setIsDropdownOpen] = createSignal(false);
  const [searchTerm, setSearchTerm] = createSignal("");
  let rootRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  /** Dismisses the attribute menu and clears its transient search query. */
  const dismiss = (): void => {
    setIsDropdownOpen(false);
    setSearchTerm("");
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

  /** Closes and clears the menu when focus moves through a pointer outside it. */
  onMount(() => {
    /** Handles pointer dismissal while retaining clicks inside the picker. */
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!rootRef?.contains(target)) dismiss();
    };

    document.addEventListener("mousedown", handlePointerDown);
    onCleanup(() => {
      document.removeEventListener("mousedown", handlePointerDown);
    });
  });

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
      <div ref={rootRef} class="relative">
        <div
          class="flex flex-wrap items-center gap-1"
          classList={{
            "min-h-10 rounded-md border border-neutral-700 bg-neutral-900/40 p-1.5":
              props.showSelectedAttributes !== false,
          }}
        >
          <Show when={props.showSelectedAttributes !== false}>
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
            when={props.showSelectedAttributes !== false}
            fallback={
              <Input
                density="compact"
                ref={searchInputRef}
                type="search"
                aria-label="Search attributes"
                value={searchTerm()}
                onFocus={() => setIsDropdownOpen(true)}
                onClick={() => setIsDropdownOpen(true)}
                onInput={(event) => {
                  setSearchTerm(event.currentTarget.value);
                  setIsDropdownOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    dismiss();
                  }
                }}
                placeholder="Search attributes..."
                class="w-full"
              />
            }
          >
            <Button
              size="compact"
              type="button"
              onClick={() => setIsDropdownOpen((open) => !open)}
              class="ml-auto items-center gap-1"
              aria-expanded={isDropdownOpen()}
            >
              Add attribute
            </Button>
          </Show>
        </div>

        <Show when={isDropdownOpen()}>
          <div class="absolute z-20 mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 shadow-lg">
            <Show when={props.showSelectedAttributes !== false}>
              <div class="border-b border-neutral-700 p-2">
                <Input
                  density="compact"
                  ref={searchInputRef}
                  type="search"
                  aria-label="Search attributes"
                  value={searchTerm()}
                  onInput={(event) => setSearchTerm(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      dismiss();
                    }
                  }}
                  placeholder="Search attributes..."
                  class="w-full"
                />
              </div>
            </Show>

            <ScrollArea
              class="max-h-52"
              viewportClass="p-1"
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
                    <Button
                      size="compact"
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={selectedSet().has(attr)}
                      class="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-neutral-200 transition-colors hover:bg-neutral-700"
                      onClick={() => toggleAttribute(attr)}
                    >
                      <span class="flex size-3.5 shrink-0 items-center justify-center">
                        <Show when={selectedSet().has(attr)}>
                          <CheckIcon class="size-3.5" aria-hidden />
                        </Show>
                      </span>
                      <span class="min-w-0 flex-1 truncate">{attr}</span>
                    </Button>
                  )}
                </For>
              </Show>
            </ScrollArea>
          </div>
        </Show>
      </div>
    </div>
  );
}
