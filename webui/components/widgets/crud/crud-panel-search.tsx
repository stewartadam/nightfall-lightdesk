// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import { XIcon } from "@squidlab/phosphor-solid/x";
import type { Accessor } from "solid-js";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { Input, InputGroup } from "../../ui/form-controls";
import { ToolbarButton } from "../../ui/toolbar-button";
import { Button } from "../../ui/visual-language/button";

type SearchableValue = string | number | boolean | null | undefined;

interface CrudPanelSearchOptions {
  componentId: string;
  label: string;
}

export interface CrudPanelSearchController {
  query: Accessor<string>;
  isOpen: Accessor<boolean>;
  isFiltering: Accessor<boolean>;
  setQuery: (query: string) => void;
  registerInput: (element: HTMLInputElement) => void;
  open: () => true;
  clear: () => boolean;
  matches: (values: readonly SearchableValue[]) => boolean;
}

interface CrudPanelSearchProps {
  search: CrudPanelSearchController;
  placeholder: string;
}

/** Normalizes a toolbar search query for case-insensitive matching. */
function normalizeCrudPanelSearchQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Returns whether a candidate value contributes searchable text. */
function isSearchableValue(
  value: SearchableValue,
): value is string | number | boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

/** Collapses whitespace so typed phrases match text with incidental spacing. */
function normalizeCrudPanelSearchText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Checks whether the query phrase appears in the provided searchable values. */
function matchesCrudPanelSearch(
  query: string,
  values: readonly SearchableValue[],
): boolean {
  if (!query) return true;
  const haystack = values
    .filter(isSearchableValue)
    .map((value) => String(value).toLowerCase())
    .join(" ");
  return normalizeCrudPanelSearchText(haystack).includes(query);
}

/** Creates shared state and shortcuts for a CRUD panel toolbar search field. */
export function createCrudPanelSearch(
  options: CrudPanelSearchOptions,
): CrudPanelSearchController {
  let inputRef: HTMLInputElement | undefined;
  const [query, setQuery] = createSignal("");
  const [isOpen, setIsOpen] = createSignal(false);

  /** Stores the normalized query used by every row matcher. */
  const normalizedQuery = createMemo(() =>
    normalizeCrudPanelSearchQuery(query()),
  );

  /** Indicates whether rows are currently being filtered. */
  const isFiltering = createMemo(() => normalizedQuery().length > 0);

  /** Focuses the search field after Solid has rendered the expanded input. */
  const focusInput = () => {
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  };

  /** Expands and focuses the toolbar search field. */
  const open = () => {
    setIsOpen(true);
    focusInput();
    return true as const;
  };

  /** Clears the current query and collapses the field when it was active. */
  const clear = () => {
    if (!isOpen() && !isFiltering()) {
      return false;
    }
    setQuery("");
    setIsOpen(false);
    return true;
  };

  /** Registers the concrete input element used by the toolbar component. */
  const registerInput = (element: HTMLInputElement) => {
    inputRef = element;
  };

  /** Tests row-specific searchable values against the current query. */
  const matches = (values: readonly SearchableValue[]) =>
    matchesCrudPanelSearch(normalizedQuery(), values);

  useKeyboardShortcut(
    {
      key: "$mod+f",
      handler: open,
      description: options.label,
      componentId: options.componentId,
    },
    { capture: true, allowInEditable: true },
  );

  return {
    query,
    isOpen,
    isFiltering,
    setQuery,
    registerInput,
    open,
    clear,
    matches,
  };
}

/** Runs a callback when the toolbar search query changes after initialization. */
export function createCrudPanelSearchQueryChangeEffect(
  search: Pick<CrudPanelSearchController, "query">,
  onQueryChange: () => void,
): void {
  createEffect((previousQuery: string | undefined) => {
    const nextQuery = search.query();
    if (previousQuery !== undefined && nextQuery !== previousQuery) {
      onQueryChange();
    }
    return nextQuery;
  });
}

/** Renders the expandable toolbar search control shared by CRUD panels. */
export default function CrudPanelSearch(props: CrudPanelSearchProps) {
  /** Clears and collapses search when Escape is pressed from the focused input. */
  const handleSearchKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!props.search.clear()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Show
      when={props.search.isOpen() || props.search.isFiltering()}
      fallback={
        <ToolbarButton
          tooltip={`${props.placeholder} (Cmd/Ctrl+F)`}
          type="button"
          label={props.placeholder}
          onClick={props.search.open}
        >
          <MagnifyingGlassIcon class="size-4" aria-hidden />
        </ToolbarButton>
      }
    >
      <InputGroup class="h-8 w-48 sm:w-56 items-center" role="search">
        <MagnifyingGlassIcon
          class="mx-2 size-4 shrink-0 self-center text-neutral-400"
          aria-hidden
        />
        <Input
          class="[&::-webkit-search-cancel-button]:hidden"
          density="compact"
          ref={props.search.registerInput}
          type="search"
          aria-label={props.placeholder}
          placeholder={props.placeholder}
          value={props.search.query()}
          onInput={(event) => props.search.setQuery(event.currentTarget.value)}
          onKeyDown={handleSearchKeyDown}
        />
        <Button
          variant="subtle"
          size="icon"
          style={{ height: "auto" }}
          type="button"
          aria-label="Clear search"
          onClick={props.search.clear}
        >
          <XIcon class="size-4" aria-hidden />
        </Button>
      </InputGroup>
    </Show>
  );
}
