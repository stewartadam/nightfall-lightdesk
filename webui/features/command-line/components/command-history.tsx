// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import { XIcon } from "@squidlab/phosphor-solid/x";
import { type Accessor, For, Show } from "solid-js";
import { Input, InputGroup } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import type { ConsoleScrollbackEntry } from "../../../lib/console-scrollback";

interface CommandHistoryProps {
  entries: Accessor<ConsoleScrollbackEntry[]>;
  totalEntries: Accessor<number>;
  normalizedSearch: Accessor<string>;
  searchOpen: Accessor<boolean>;
  search: Accessor<string>;
  onSearchInput: (value: string) => void;
  onSearchKeyDown: (event: KeyboardEvent) => void;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onClear: () => void;
  searchRef: (element: HTMLInputElement) => void;
  scrollbackRef: (element: HTMLDivElement) => void;
}

/** Formats a console history timestamp for the compact command log. */
const formatTimestamp = (timestampMs: number): string =>
  new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** Renders command history controls, search, and scrollback entries. */
export const CommandHistory = (props: CommandHistoryProps) => (
  <>
    <div class="border-b border-neutral-800 px-2 py-1 text-xs">
      <div class="flex items-center justify-between gap-2">
        <span class="text-neutral-400">
          {props.normalizedSearch()
            ? `History: ${props.entries().length}/${props.totalEntries()}`
            : `History: ${props.totalEntries()}`}
        </span>
        <div class="flex items-center gap-1">
          <Button
            size="compact"
            type="button"
            class="items-center justify-center"
            aria-label="Search command history"
            title="Search command history (Mod+F)"
            onClick={() => props.onOpenSearch()}
          >
            <MagnifyingGlassIcon class="size-4" aria-hidden />
          </Button>
          <Button size="compact" type="button" onClick={() => props.onClear()}>
            Clear
          </Button>
        </div>
      </div>
      <Show when={props.searchOpen()}>
        <div class="mt-1 flex items-center gap-1">
          <InputGroup class="flex-1">
            <MagnifyingGlassIcon
              class="ml-2 size-4 shrink-0 self-center text-neutral-500"
              aria-hidden
            />
            <Input
              density="compact"
              ref={props.searchRef}
              type="search"
              class="w-full"
              aria-label="Command history search"
              placeholder="Search history"
              value={props.search()}
              onInput={(event) =>
                props.onSearchInput(event.currentTarget.value)
              }
              onKeyDown={props.onSearchKeyDown}
            />
          </InputGroup>
          <Button
            size="compact"
            type="button"
            class="items-center justify-center"
            aria-label="Close history search"
            title="Close search"
            onClick={() => props.onCloseSearch()}
          >
            <XIcon class="size-4" aria-hidden />
          </Button>
        </div>
      </Show>
    </div>

    <div ref={props.scrollbackRef} class="flex-1 overflow-auto p-2 text-sm">
      <Show
        when={props.totalEntries() > 0}
        fallback={
          <div class="text-xs font-mono text-neutral-500">
            No commands yet. Enter a command below.
          </div>
        }
      >
        <Show
          when={props.entries().length > 0}
          fallback={
            <div class="text-xs font-mono text-neutral-500">
              No commands match the current search.
            </div>
          }
        >
          <div class="space-y-1">
            <For each={props.entries()}>
              {(entry) => (
                <div class="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1">
                  <div class="flex items-start gap-2">
                    <span class="shrink-0 text-xs text-neutral-500">
                      {formatTimestamp(entry.submittedAt)}
                    </span>
                    <span
                      class={`shrink-0 text-xs ${
                        entry.status === "error"
                          ? "text-red-400"
                          : entry.status === "success"
                            ? "text-green-400"
                            : "text-yellow-400"
                      }`}
                    >
                      {entry.status === "error"
                        ? "⚠️"
                        : entry.status === "success"
                          ? "✅"
                          : "..."}
                    </span>
                    <span class="shrink-0 rounded border border-neutral-700 px-1 py-0 text-[10px] uppercase tracking-wide text-neutral-300">
                      {entry.source || "UI"}
                    </span>
                    <span class="break-all font-mono text-neutral-100">
                      {entry.command}
                    </span>
                  </div>
                  <Show when={entry.status === "error" && entry.errorMessage}>
                    <div class="ml-20 pt-0.5 text-xs text-red-400 break-words">
                      {entry.errorMessage}
                    </div>
                  </Show>
                  <Show
                    when={entry.status === "success" && entry.resultMessage}
                  >
                    <pre class="ml-20 whitespace-pre-wrap pt-0.5 text-xs text-neutral-300 break-words">
                      {entry.resultMessage}
                    </pre>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  </>
);
