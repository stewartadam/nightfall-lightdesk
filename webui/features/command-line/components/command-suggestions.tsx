// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, For, Show } from "solid-js";
import {
  SearchPickerOption,
  SearchPickerSurface,
} from "../../../components/ui/search-picker";
import {
  isIntentSuggestion,
  isTokenSuggestion,
  type RankedCommandIntentSuggestion,
  type RankedCommandSuggestion,
  type RankedCommandTokenSuggestion,
} from "../../../lib/command-autocomplete";

interface CommandSuggestionsProps {
  variant: "panel" | "nav";
  suggestions: Accessor<RankedCommandSuggestion[]>;
  selectedIndex: Accessor<number>;
  intentSublistLabel: Accessor<string | undefined>;
  breadcrumbLabel: Accessor<string | null>;
  onOpenIntent: (
    suggestion: RankedCommandIntentSuggestion,
    index: number,
  ) => void;
  onApplyToken: (suggestion: RankedCommandTokenSuggestion) => void;
  onHover: (index: number) => void;
}

/** Renders command autocomplete rows and their breadcrumb/sublist context. */
export const CommandSuggestions = (props: CommandSuggestionsProps) => {
  /** Returns whether the selected row supports a Tab action. */
  const isTabActionable = (suggestion: RankedCommandSuggestion) =>
    isIntentSuggestion(suggestion)
      ? suggestion.tokenOptions.length > 0
      : suggestion.completable;

  return (
    <Show when={props.suggestions().length > 0}>
      <SearchPickerSurface
        data-command-autocomplete="suggestions"
        role="listbox"
        class="absolute z-20 left-0 right-0 mt-1"
        style={{ "max-height": "192px", "overflow-y": "auto" }}
      >
        <Show when={!props.breadcrumbLabel() && props.intentSublistLabel()}>
          <div
            data-command-autocomplete="intent-sublist-label"
            class={
              props.variant === "panel"
                ? "border-b border-neutral-700/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400"
                : "border-b border-gray-200 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:border-slate-700 dark:text-slate-400"
            }
          >
            {props.intentSublistLabel()}
          </div>
        </Show>
        <Show when={props.breadcrumbLabel()}>
          <div
            data-command-autocomplete="breadcrumb"
            class={
              props.variant === "panel"
                ? "border-b border-neutral-700/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400"
                : "border-b border-gray-200 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:border-slate-700 dark:text-slate-400"
            }
          >
            {props.breadcrumbLabel()}
          </div>
        </Show>
        <For each={props.suggestions()}>
          {(suggestion, index) => (
            <SearchPickerOption
              type="button"
              tabIndex={-1}
              data-command-autocomplete="suggestion-row"
              role="option"
              aria-selected={
                props.selectedIndex() === index() ? "true" : "false"
              }
              data-suggestion-kind={suggestion.kind}
              data-intent-id={
                isIntentSuggestion(suggestion) ? suggestion.intentId : undefined
              }
              data-insert-text={
                isTokenSuggestion(suggestion)
                  ? suggestion.insertText
                  : undefined
              }
              density="compact"
              selected={props.selectedIndex() === index()}
              style={{ "font-family": "var(--font-mono)" }}
              onMouseDown={(event) => {
                event.preventDefault();
                if (isIntentSuggestion(suggestion)) {
                  props.onOpenIntent(suggestion, index());
                  return;
                }
                if (suggestion.completable) props.onApplyToken(suggestion);
              }}
              onMouseEnter={() => props.onHover(index())}
            >
              <span class="flex w-full items-center justify-between gap-2">
                <span class="flex min-w-0 items-center gap-2">
                  <span class="truncate">{suggestion.label}</span>
                  <Show
                    when={
                      isTokenSuggestion(suggestion) &&
                      suggestion.label.toLowerCase() !==
                        suggestion.insertText.toLowerCase()
                    }
                  >
                    <span
                      class={
                        props.variant === "panel"
                          ? "rounded border border-neutral-600 px-1 text-[10px] text-neutral-300"
                          : "rounded border border-gray-300 px-1 text-[10px] text-gray-600 dark:border-slate-600 dark:text-slate-300"
                      }
                    >
                      {isTokenSuggestion(suggestion)
                        ? suggestion.insertText
                        : ""}
                    </span>
                  </Show>
                  <Show when={isIntentSuggestion(suggestion)}>
                    <span class="inline-flex items-center gap-1 text-[10px] text-neutral-400 dark:text-slate-400">
                      <For
                        each={
                          isIntentSuggestion(suggestion) ? suggestion.hints : []
                        }
                      >
                        {(hint) => (
                          <span
                            class={
                              props.variant === "panel"
                                ? "rounded border border-neutral-600 px-1 text-[10px] text-neutral-300"
                                : "rounded border border-gray-300 px-1 text-[10px] text-gray-600 dark:border-slate-600 dark:text-slate-300"
                            }
                          >
                            {hint}
                          </span>
                        )}
                      </For>
                      <Show
                        when={
                          isIntentSuggestion(suggestion) &&
                          suggestion.hintOverflow
                        }
                      >
                        <span>…</span>
                      </Show>
                    </span>
                  </Show>
                </span>
                <Show
                  when={
                    props.selectedIndex() === index() &&
                    isTabActionable(suggestion)
                  }
                >
                  <span
                    class={
                      props.variant === "panel"
                        ? "rounded border border-neutral-500 px-1 text-[10px] uppercase tracking-wide text-neutral-300"
                        : "rounded border border-gray-300 px-1 text-[10px] uppercase tracking-wide text-gray-600 dark:border-slate-600 dark:text-gray-300"
                    }
                  >
                    Tab
                  </span>
                </Show>
              </span>
            </SearchPickerOption>
          )}
        </For>
      </SearchPickerSurface>
    </Show>
  );
};
