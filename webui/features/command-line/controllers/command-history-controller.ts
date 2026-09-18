// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal, type Setter } from "solid-js";
import { consoleScrollback } from "../../../state/appStores";
import { isHistorySearchShortcut } from "../model/keyboard";
import { commandLineHistory } from "../state/history";

interface CommandHistoryControllerOptions {
  variant: "panel" | "nav";
  setInput: Setter<string>;
  onHistoryValue: (value: string) => void;
  onHistoryCleared: () => void;
  getInputElement: () => HTMLInputElement | undefined;
}

/** Owns persisted command navigation and searchable console history state. */
export function createCommandHistoryController(
  options: CommandHistoryControllerOptions,
) {
  const consoleEntries = useStore(consoleScrollback);
  const history = useStore(commandLineHistory);
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [historySearchOpen, setHistorySearchOpen] = createSignal(false);
  const [historySearch, setHistorySearch] = createSignal("");
  let scrollbackElement: HTMLDivElement | undefined;
  let historySearchElement: HTMLInputElement | undefined;

  /** Normalizes the history query for case-insensitive matching. */
  const normalizedHistorySearch = createMemo(() =>
    historySearch().trim().toLowerCase(),
  );

  /** Returns console entries matching command, source, status, or result text. */
  const visibleConsoleEntries = createMemo(() => {
    const entries = consoleEntries();
    const query = normalizedHistorySearch();
    if (!query) return entries;
    return entries.filter((entry) =>
      [
        entry.command,
        entry.source,
        entry.status,
        entry.errorMessage ?? "",
        entry.resultMessage ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  });

  /** Moves through persisted commands and restores a blank draft after the end. */
  const navigate = (direction: "prev" | "next") => {
    const entries = history();
    if (entries.length === 0) return;
    let index = historyIndex();
    if (direction === "prev") {
      index = index < 0 ? entries.length - 1 : Math.max(0, index - 1);
    } else {
      if (index < 0) return;
      index += 1;
      if (index >= entries.length) {
        setHistoryIndex(-1);
        options.setInput("");
        options.onHistoryCleared();
        return;
      }
    }
    setHistoryIndex(index);
    const value = entries[index] ?? "";
    options.setInput(value);
    options.onHistoryValue(value);
  };

  /** Opens console history search and transfers focus into its input. */
  const openSearch = () => {
    setHistorySearchOpen(true);
    queueMicrotask(() => {
      historySearchElement?.focus();
      historySearchElement?.select();
    });
  };

  /** Closes console history search and restores command-input focus. */
  const closeSearch = () => {
    setHistorySearch("");
    setHistorySearchOpen(false);
    queueMicrotask(() => options.getInputElement()?.focus());
  };

  /** Handles search-specific shortcuts while focus remains in its input. */
  const handleSearchKeyDown = (event: KeyboardEvent) => {
    if (isHistorySearchShortcut(event)) {
      openSearch();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      closeSearch();
      event.preventDefault();
      event.stopPropagation();
    }
  };

  /** Captures the console scrollback element used for automatic scrolling. */
  const setScrollbackElement = (element: HTMLDivElement) => {
    scrollbackElement = element;
  };

  /** Captures the history search element used for focus management. */
  const setHistorySearchElement = (element: HTMLInputElement) => {
    historySearchElement = element;
  };

  /** Keeps a panel's console scrollback pinned to the newest entry. */
  createEffect(() => {
    if (options.variant !== "panel") return;
    const entries = consoleEntries();
    if (!scrollbackElement || entries.length === 0) return;
    queueMicrotask(() => {
      if (scrollbackElement)
        scrollbackElement.scrollTop = scrollbackElement.scrollHeight;
    });
  });

  return {
    consoleEntries,
    historySearchOpen,
    historySearch,
    setHistorySearch,
    normalizedHistorySearch,
    visibleConsoleEntries,
    setHistoryIndex,
    navigate,
    openSearch,
    closeSearch,
    handleSearchKeyDown,
    setScrollbackElement,
    setHistorySearchElement,
  };
}
