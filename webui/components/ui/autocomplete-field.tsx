// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  splitProps,
} from "solid-js";
import { createEffect } from "../../lib/solid-compat";
import {
  type AutocompleteOption,
  filterAutocompleteOptions,
} from "./autocomplete-options";
import { Input } from "./form-controls";
import { MenuItem, MenuSurface } from "./menu";
import { Popover } from "./popover";
import { ScrollArea } from "./scroll-area";

export type { AutocompleteOption } from "./autocomplete-options";

type InputKeyboardEvent = KeyboardEvent & {
  currentTarget: HTMLInputElement;
  target: Element;
};
type InputFocusEvent = FocusEvent & {
  currentTarget: HTMLInputElement;
  target: Element;
};

export type AutocompleteFieldProps = Omit<
  Parameters<typeof Input>[0],
  | "value"
  | "onInput"
  | "onKeyDown"
  | "onBlur"
  | "onClick"
  | "list"
  | "role"
  | "ref"
> & {
  /** Text the field shows. */
  value: string;
  /** Values to suggest, in the order they should be listed. */
  options: readonly AutocompleteOption[];
  /** Receives every keystroke's text. */
  onInput: (value: string) => void;
  /** Receives a suggestion the user chose with a click or with Enter. */
  onPick: (value: string) => void;
  /** Receives keys the suggestion list does not use, such as Enter with nothing highlighted. */
  onKeyDown?: (event: InputKeyboardEvent) => void;
  /** Runs when the field loses focus, after the suggestion list closes. */
  onBlur?: (event: InputFocusEvent) => void;
  /** Accessible name of the suggestion list. */
  listLabel?: string;
};

/**
 * A text field that suggests values from a list while still taking any text. Clicking the
 * field or pressing Down lists every suggestion with the current value checked, and typing
 * narrows the list. Up and Down highlight a suggestion and Enter picks it; with nothing
 * highlighted, Enter belongs to the field. Escape closes the list before anything else sees it.
 * The list is the shared menu in a `Popover`, so it looks like every other menu and stays
 * usable inside dialogs and scrolling panels.
 */
export function AutocompleteField(props: AutocompleteFieldProps) {
  const [local, rest] = splitProps(props, [
    "value",
    "options",
    "onInput",
    "onPick",
    "onKeyDown",
    "onBlur",
    "listLabel",
  ]);
  const listId = createUniqueId();
  const [open, setOpen] = createSignal(false);
  /** Text the list is narrowed by, or null to list every suggestion. */
  const [query, setQuery] = createSignal<string | null>(null);
  /**
   * Value of the suggestion the keyboard highlights, or null. Held by value rather than
   * position, so a list that changes while open (new options, narrower text) never moves the
   * highlight onto another suggestion.
   */
  const [activeValue, setActiveValue] = createSignal<string | null>(null);
  let input: HTMLInputElement | undefined;

  /** Suggestions the list shows for the current text. */
  const shown = createMemo((): readonly AutocompleteOption[] => {
    const text = query();
    return text === null
      ? local.options
      : filterAutocompleteOptions(local.options, text);
  });

  /** Position of the highlighted suggestion in the list, or -1 when none is listed. */
  const active = () => {
    const value = activeValue();
    return value === null
      ? -1
      : shown().findIndex((option) => option.value === value);
  };

  /** Whether the list is on screen, which needs it open and at least one suggestion to show. */
  const listed = () => open() && shown().length > 0;

  /** Element id of one listed suggestion, for `aria-activedescendant`. */
  const optionId = (index: number) => `${listId}-${index}`;

  /**
   * Scrolls the highlighted suggestion into view once the list has rendered, for keyboard
   * moves and for the current value when the list opens. Pointer hover never scrolls.
   */
  const revealActive = () => {
    requestAnimationFrame(() => {
      if (active() < 0) return;
      document
        .getElementById(optionId(active()))
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  /** Lists every suggestion, highlighting the current value when it is one of them. */
  const showAll = () => {
    setQuery(null);
    setActiveValue(
      local.options.some((option) => option.value === local.value)
        ? local.value
        : null,
    );
    setOpen(true);
    revealActive();
  };

  /** Closes the list and forgets the narrowing text and highlight. */
  const close = () => {
    setOpen(false);
    setQuery(null);
    setActiveValue(null);
  };

  /** Text this field last reported through `onInput`, to tell the user's typing from outside changes. */
  let typed = local.value;

  /** Closes the list when the value changes from outside, such as a form clearing the field. */
  createEffect(
    () => local.value,
    (value) => {
      if (value !== typed) close();
      typed = value;
    },
    { defer: true },
  );

  /** Closes the list and hands the chosen suggestion to the caller. */
  const pick = (value: string) => {
    close();
    local.onPick(value);
  };

  /**
   * Moves the highlight by `step`, stopping at the ends. With nothing highlighted, Down starts
   * at the first suggestion and Up at the last. Opens the full list when none is on screen.
   */
  const move = (step: number) => {
    if (!listed()) {
      showAll();
      return;
    }
    const list = shown();
    const index = active();
    const next =
      index < 0
        ? step > 0
          ? 0
          : list.length - 1
        : Math.min(list.length - 1, Math.max(0, index + step));
    setActiveValue(list[next].value);
    revealActive();
  };

  /**
   * Gives Up and Down to the list and Enter to a highlighted suggestion, and passes every other
   * key, including Enter with nothing highlighted, to the caller.
   */
  const handleKeyDown: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = (
    event,
  ) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    const highlighted = listed() ? shown()[active()] : undefined;
    if (event.key === "Enter" && highlighted) {
      event.preventDefault();
      pick(highlighted.value);
      return;
    }
    local.onKeyDown?.(event);
  };

  return (
    <>
      <Input
        {...rest}
        ref={input}
        value={local.value}
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        aria-expanded={listed()}
        aria-controls={listId}
        aria-activedescendant={active() >= 0 ? optionId(active()) : undefined}
        onClick={() => {
          if (!listed()) showAll();
        }}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setActiveValue(null);
          setOpen(true);
          typed = event.currentTarget.value;
          local.onInput(event.currentTarget.value);
        }}
        onKeyDown={handleKeyDown}
        onBlur={(event) => {
          close();
          local.onBlur?.(event);
        }}
      />
      <Popover
        anchor={() => input}
        open={listed()}
        onClose={close}
        placement="auto"
        matchAnchorWidth
        initialFocus="none"
        returnFocus={() => input}
        surface={MenuSurface}
        class="flex min-w-48 flex-col"
        // Presses anywhere in the list, its scrollbar included, keep typing focus in the field.
        onPointerDown={(event) => event.preventDefault()}
      >
        <ScrollArea
          class="min-h-0 max-h-60"
          viewportProps={{
            id: listId,
            role: "listbox",
            "aria-label": local.listLabel,
          }}
        >
          <For each={shown()}>
            {(option, index) => (
              <MenuItem
                id={optionId(index())}
                role="option"
                tabIndex={-1}
                aria-selected={index() === active()}
                active={index() === active()}
                checked={option.value === local.value}
                description={option.description}
                // The pointer takes over from the keyboard, so only one row ever shows a highlight.
                onPointerMove={() => {
                  if (activeValue() !== null) setActiveValue(null);
                }}
                onClick={() => pick(option.value)}
              >
                {option.value}
              </MenuItem>
            )}
          </For>
        </ScrollArea>
      </Popover>
    </>
  );
}
