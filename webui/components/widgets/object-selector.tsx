// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { ScrollArea } from "../ui/scroll-area";

export interface ObjectSelectorProps<T> {
  items: T[];
  selectedKey?: string;
  onSelect: (item: T) => void;
  getKey: (item: T) => string;
  getPrimaryText: (item: T) => string;
  getSecondaryText?: (item: T) => string | undefined;
  getSearchText?: (item: T) => string;
  filter?: (item: T, query: string) => boolean;
  placeholder?: string;
  ariaLabel?: string;
  emptyMessage?: string;
}

/** Matches case-insensitive search text across object labels and metadata. */
function includesQuery(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query.toLowerCase());
}

/** Renders a searchable object list with controlled selection and keyboard navigation. */
export default function ObjectSelector<T>(props: ObjectSelectorProps<T>) {
  const [query, setQuery] = createSignal("");
  const [highlightedIndex, setHighlightedIndex] = createSignal(0);

  /** Filters candidates using caller search rules or the displayed text. */
  const filteredItems = createMemo(() => {
    const text = query().trim();
    const source = props.items;

    if (text.length === 0) {
      return source;
    }

    if (props.filter) {
      return source.filter((item) => props.filter!(item, text));
    }

    return source.filter((item) => {
      const primary = props.getPrimaryText(item);
      const secondary = props.getSecondaryText?.(item) ?? "";
      const extra = props.getSearchText?.(item) ?? "";
      return (
        includesQuery(primary, text) ||
        includesQuery(secondary, text) ||
        includesQuery(extra, text)
      );
    });
  });

  /** Keeps the highlighted row within the filtered list and aligned with selection. */
  createEffect(() => {
    const current = filteredItems();
    if (current.length === 0) {
      setHighlightedIndex(0);
      return;
    }

    const selectedKey = props.selectedKey;
    if (!selectedKey) {
      if (highlightedIndex() >= current.length) {
        setHighlightedIndex(0);
      }
      return;
    }

    const selectedIdx = current.findIndex(
      (item) => props.getKey(item) === selectedKey,
    );
    if (selectedIdx >= 0) {
      setHighlightedIndex(selectedIdx);
    } else if (highlightedIndex() >= current.length) {
      setHighlightedIndex(0);
    }
  });

  /** Moves the keyboard highlight or selects the highlighted result. */
  const handleKeyDown = (event: KeyboardEvent) => {
    const list = filteredItems();
    if (list.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % list.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev - 1 + list.length) % list.length);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      props.onSelect(list[highlightedIndex()]);
    }
  };

  return (
    <div class="object-selector space-y-2">
      <input
        type="text"
        aria-label={props.ariaLabel ?? "Filter objects"}
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder={props.placeholder ?? "Filter..."}
        class="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500"
      />

      <ScrollArea
        class="max-h-56 rounded border border-neutral-700 bg-neutral-900"
        viewportProps={{
          role: "region",
          "aria-label": "Matching objects",
          tabIndex: 0,
        }}
      >
        <Show
          when={filteredItems().length > 0}
          fallback={
            <div class="px-3 py-4 text-sm text-neutral-500 text-center">
              {props.emptyMessage ?? "No matching objects."}
            </div>
          }
        >
          <For each={filteredItems()}>
            {(item, idx) => {
              /** Resolves stable identity for this object row. */
              const key = () => props.getKey(item);

              /** Indicates the caller's current selection. */
              const isSelected = () => props.selectedKey === key();

              /** Indicates the result targeted by keyboard navigation. */
              const isHighlighted = () => highlightedIndex() === idx();

              /** Resolves optional supporting text beneath the object name. */
              const secondary = () => props.getSecondaryText?.(item);

              return (
                <button
                  type="button"
                  aria-pressed={isSelected()}
                  class="w-full px-3 py-2 text-left border-b border-neutral-800 last:border-b-0 transition-colors"
                  classList={{
                    "bg-blue-600/25": isSelected(),
                    "bg-neutral-800": !isSelected() && isHighlighted(),
                    "hover:bg-neutral-800": !isSelected(),
                  }}
                  onClick={() => props.onSelect(item)}
                >
                  <div class="text-sm text-white">
                    {props.getPrimaryText(item)}
                  </div>
                  <Show when={secondary()}>
                    <div class="text-xs text-neutral-400">{secondary()}</div>
                  </Show>
                </button>
              );
            }}
          </For>
        </Show>
      </ScrollArea>
    </div>
  );
}
