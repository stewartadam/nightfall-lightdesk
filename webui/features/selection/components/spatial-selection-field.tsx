// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createSignal, Show } from "solid-js";
import { Input, Textarea } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { getLogger } from "../../../lib/logger";
import {
  formatSpatialSelection,
  parseSpatialSelection,
} from "../../../lib/wasm-bridge";
import {
  fixtures as fixturesStore,
  groups as groupsStore,
  pushToast,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { spatialSelectionForEditing } from "../model/spatial-selection-editor-model";

const log = getLogger(import.meta.url);

export interface SpatialSelectionFieldProps {
  /** Current authored or persisted spatial selection. */
  selection: types.SpatialSelection | null;
  /** Receives parser output after the user commits valid command text. */
  onChange: (selection: types.SpatialSelection) => void | Promise<void>;
  /** Label exposed visually and to assistive technology. */
  label?: string;
  /** Optional container class for compact layouts. */
  class?: string;
  /** Expanded fields remain editable and expose explicit reset/apply actions. */
  variant?: "compact" | "expanded";
  /** Prevents editing or applying the current value. */
  disabled?: boolean;
  /** Optional serialized revision for selections backed by mutable store proxies. */
  revision?: string;
  /** Command-language hint shown when the field is empty. */
  placeholder?: string;
}

/** Renders one reusable, parser-backed field for authored spatial selections. */
export function SpatialSelectionField(props: SpatialSelectionFieldProps) {
  log.trace("mounting");
  const $fixtures = useStore(fixturesStore);
  const $groups = useStore(groupsStore);
  const [isEditing, setIsEditing] = createSignal(false);
  const [isApplying, setIsApplying] = createSignal(false);
  const [isDirty, setIsDirty] = createSignal(false);
  const [inputValue, setInputValue] = createSignal("");
  const [displayText, setDisplayText] = createSignal("Selection");
  let formatGeneration = 0;
  let inputRef: HTMLInputElement | undefined;
  let skipNextBlur = false;

  /** Reports whether external selection updates should replace the visible editor text. */
  const shouldSynchronizeInput = (): boolean =>
    (props.variant ?? "compact") === "expanded" || !isDirty();

  /** Formats stable references through current fixture/group IDs without mutating stored data. */
  const formatCurrentSelection = async (): Promise<string> => {
    const selection = props.selection;
    if (!selection) return "";
    return formatSpatialSelection(
      spatialSelectionForEditing(selection, $fixtures(), $groups()),
    );
  };

  /** Synchronizes display text when selection data or reference aliases change. */
  createEffect(() => {
    const revision = props.revision;
    const selection = props.selection;
    const fixtures = $fixtures();
    const groups = $groups();
    const generation = ++formatGeneration;
    if (!selection) {
      setDisplayText("Selection");
      if (shouldSynchronizeInput()) setInputValue("");
      return;
    }
    void formatSpatialSelection(
      spatialSelectionForEditing(selection, fixtures, groups),
    )
      .then((formatted) => {
        if (generation !== formatGeneration || revision !== props.revision)
          return;
        setDisplayText(formatted);
        if (shouldSynchronizeInput()) setInputValue(formatted);
      })
      .catch((error) => {
        log.error("Failed to format spatial selection", error);
        if (generation !== formatGeneration || revision !== props.revision)
          return;
        setDisplayText("Selection");
        if (shouldSynchronizeInput()) setInputValue("");
      });
  });

  /** Focuses and selects compact input text after entering edit mode. */
  createEffect(() => {
    if (!isEditing() || !inputRef) return;
    inputRef.focus();
    inputRef.select();
  });

  /** Opens the compact editor with freshly resolved user-facing command text. */
  const startEditing = async (): Promise<void> => {
    if (props.disabled || !props.selection) return;
    skipNextBlur = false;
    try {
      setInputValue(await formatCurrentSelection());
    } catch (error) {
      log.error("Failed to prepare spatial selection editor", error);
      setInputValue(displayText());
    }
    setIsDirty(false);
    setIsEditing(true);
  };

  /** Parses and publishes the current command text while retaining invalid edits. */
  const apply = async (): Promise<void> => {
    if (isApplying() || props.disabled) return;
    const input = inputValue().trim();
    if (!input) {
      if ((props.variant ?? "compact") === "compact") {
        setIsDirty(false);
        setIsEditing(false);
        return;
      }
      pushToast("error", "Spatial selection cannot be empty.");
      return;
    }

    setIsApplying(true);
    try {
      const parsed = await parseSpatialSelection(input);
      if (!parsed) {
        pushToast(
          "error",
          `Invalid selection: "${input}". Expected formats: Fixture 1, Fixture 1>10, Group 1, or spatial clauses like Grid 4 | Wings 2.`,
        );
        return;
      }
      await props.onChange(parsed);
      setDisplayText(input);
      setIsDirty(false);
      setIsEditing(false);
    } catch (error) {
      log.error("Failed to apply spatial selection", error);
      pushToast("error", "Failed to apply spatial selection.");
    } finally {
      setIsApplying(false);
    }
  };

  /** Restores the current selection text after an expanded-field edit. */
  const reset = async (): Promise<void> => {
    try {
      const formatted = await formatCurrentSelection();
      setInputValue(formatted);
      setDisplayText(formatted || "Selection");
      setIsDirty(false);
    } catch (error) {
      log.error("Failed to reset spatial selection editor", error);
    }
  };

  /** Records user-authored text without changing the structured selection until commit. */
  const updateInput = (value: string): void => {
    setInputValue(value);
    setIsDirty(true);
  };

  /** Handles compact keyboard commit and cancellation behavior. */
  const handleCompactKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") void apply();
    if (event.key === "Escape") {
      skipNextBlur = true;
      setIsDirty(false);
      setIsEditing(false);
    }
  };

  /** Commits compact edits on blur unless keyboard cancellation caused the blur. */
  const handleCompactBlur = (): void => {
    if (skipNextBlur) {
      skipNextBlur = false;
      return;
    }
    void apply();
  };

  /** Returns the command-language hint for the active field layout. */
  const placeholder = () =>
    props.placeholder ?? "Fixture 1, Fixture 1>10, or Group 1";
  /** Returns the visual and accessible field label. */
  const label = () => props.label ?? "Fixtures";

  return (
    <Show
      when={(props.variant ?? "compact") === "expanded"}
      fallback={
        <div class={props.class ?? "flex min-w-80 flex-col gap-1"}>
          <label class="text-xs text-neutral-400">{label()}</label>
          <Show
            when={isEditing()}
            fallback={
              <Button
                size="compact"
                type="button"
                class="rounded bg-neutral-800 px-3 py-2 text-left text-sm transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void startEditing()}
                disabled={props.disabled || !props.selection}
              >
                {displayText()}
              </Button>
            }
          >
            <Input
              density="compact"
              ref={inputRef}
              type="text"
              aria-label={label()}
              value={inputValue()}
              onInput={(event) => updateInput(event.currentTarget.value)}
              onKeyDown={handleCompactKeyDown}
              onBlur={handleCompactBlur}
              class="w-full"
              placeholder={placeholder()}
            />
          </Show>
        </div>
      }
    >
      <div class={props.class ?? "space-y-2"}>
        <Textarea
          density="compact"
          aria-label={label()}
          value={inputValue()}
          onInput={(event) => updateInput(event.currentTarget.value)}
          class="min-h-24 w-full font-mono"
          placeholder={placeholder()}
          disabled={props.disabled}
        />
        <div class="flex items-center justify-end gap-2">
          <Button
            size="compact"
            type="button"
            class="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void reset()}
            disabled={props.disabled || !props.selection}
          >
            Reset
          </Button>
          <Button
            size="compact"
            type="button"
            variant="primary"
            onClick={() => void apply()}
            disabled={props.disabled || isApplying()}
          >
            Apply
          </Button>
        </div>
      </div>
    </Show>
  );
}
