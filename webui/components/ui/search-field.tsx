// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import { XIcon } from "@squidlab/phosphor-solid/x";
import { Show } from "solid-js";
import { Input, InputGroup } from "./form-controls";
import { Button } from "./visual-language/button";

interface SearchFieldProps {
  /** Current query text. */
  value: string;
  /** Receives the query on every keystroke, and an empty string when cleared. */
  onInput: (value: string) => void;
  /** Accessible name of the field, also used as its placeholder unless one is given. */
  label: string;
  placeholder?: string;
  /** Uses the shorter control height of toolbars and inline editors. */
  density?: "comfortable" | "compact";
  autofocus?: boolean;
  /** Classes for the outer group, such as a width. */
  class?: string;
  ref?: (element: HTMLInputElement) => void;
  /**
   * Clears and collapses a field that is only shown on demand, such as a toolbar search. When
   * given, the clear button stays visible, and both it and Escape call this instead of clearing.
   */
  onDismiss?: () => void;
  "data-testid"?: string;
}

/**
 * A search box with a magnifier and a clear button. Escape clears a typed query and keeps focus in
 * the field, or dismisses the field when `onDismiss` is given. On an empty field without
 * `onDismiss`, Escape reaches the surrounding surface, such as a dialog that closes on Escape.
 */
export function SearchField(props: SearchFieldProps) {
  let input: HTMLInputElement | undefined;

  /** Empties the query and returns focus to the field so typing can continue. */
  const clear = () => {
    props.onInput("");
    input?.focus();
  };

  /** Dismisses the field on Escape when it can be, otherwise clears any typed text. */
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (props.onDismiss) {
      props.onDismiss();
    } else if (props.value) {
      clear();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <InputGroup
      class={`items-center ${props.class ?? ""}`}
      role="search"
      data-testid={props["data-testid"]}
    >
      <MagnifyingGlassIcon
        class="mx-2 size-4 shrink-0 self-center text-neutral-400"
        aria-hidden
      />
      <Input
        class="[&::-webkit-search-cancel-button]:hidden"
        density={props.density}
        ref={(element) => {
          input = element;
          props.ref?.(element);
        }}
        type="search"
        // Keeps a surrounding dialog from taking Escape while the field has something to clear.
        data-owns-dialog-keys={props.value || props.onDismiss ? "" : undefined}
        autofocus={props.autofocus}
        aria-label={props.label}
        placeholder={props.placeholder ?? props.label}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <Show when={props.value || props.onDismiss}>
        <Button
          variant="subtle"
          size="icon"
          style={{ height: "auto" }}
          type="button"
          aria-label="Clear search"
          onClick={() => (props.onDismiss ? props.onDismiss() : clear())}
        >
          <XIcon class="size-4" aria-hidden />
        </Button>
      </Show>
    </InputGroup>
  );
}
