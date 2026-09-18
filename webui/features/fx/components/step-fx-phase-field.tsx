// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, Show } from "solid-js";
import { Input } from "../../../components/ui/form-controls";
import { getLogger } from "../../../lib/logger";
import { formatStepFxPhase, parseStepFxPhase } from "../../../lib/wasm-bridge";
import type * as types from "../../../types";

const log = getLogger(import.meta.url);
const PHASE_FIELD_CLASS =
  "rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-[var(--accent)] focus:outline-none disabled:opacity-50";

export interface StepFxPhaseFieldProps {
  /** Authored normalized phase waypoints. */
  phase: types.StepFxPhase;
  /** Receives parser output after valid command text is committed. */
  onChange: (phase: types.StepFxPhase) => void | Promise<void>;
  /** Accessible label describing the phase scope. */
  ariaLabel: string;
  /** Optional classes appended to the shared field appearance. */
  class?: string;
  /** Prevents editing and applying the current phase. */
  disabled?: boolean;
  /** Monotonic request token that focuses and selects the authored expression. */
  focusRequest?: number;
}

/** Renders one reusable parser-backed field for authored Step FX phase waypoints. */
export function StepFxPhaseField(props: StepFxPhaseFieldProps) {
  const [inputValue, setInputValue] = createSignal("");
  const [isDirty, setIsDirty] = createSignal(false);
  const [isApplying, setIsApplying] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let formatGeneration = 0;
  let skipNextBlur = false;
  let inputRef: HTMLInputElement | undefined;

  /** Synchronizes canonical text from external phase updates unless an invalid edit is retained. */
  createEffect(() => {
    const phase = props.phase;
    const generation = ++formatGeneration;
    if (isDirty()) return;
    void formatStepFxPhase(phase)
      .then((formatted) => {
        if (generation !== formatGeneration || isDirty()) return;
        setInputValue(formatted);
      })
      .catch((cause) => {
        log.error("Failed to format Step FX phase", cause);
      });
  });

  /** Applies explicit editor focus requests after portaled menu content mounts. */
  createEffect(() => {
    const request = props.focusRequest;
    if (!request) return;
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  });

  /** Parses and publishes the authored expression while retaining invalid text for correction. */
  const apply = async (): Promise<void> => {
    if (isApplying() || props.disabled || !isDirty()) return;
    const input = inputValue().trim();
    setIsApplying(true);
    try {
      const parsed = await parseStepFxPhase(input);
      if (!parsed) {
        setError("Enter a phase such as 180, 0>360, or 0>360>0.");
        return;
      }
      await props.onChange(parsed);
      setInputValue(await formatStepFxPhase(parsed));
      setError(undefined);
      setIsDirty(false);
    } catch (cause) {
      log.error("Failed to apply Step FX phase", cause);
      setError("Failed to apply the phase expression.");
    } finally {
      setIsApplying(false);
    }
  };

  /** Handles commit and cancellation without losing invalid in-progress input. */
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      void apply();
    }
    if (event.key === "Escape") {
      skipNextBlur = true;
      setIsDirty(false);
      setError(undefined);
      void formatStepFxPhase(props.phase).then(setInputValue);
      inputRef?.blur();
    }
  };

  /** Commits valid text when focus leaves the field unless Escape caused the blur. */
  const handleBlur = (): void => {
    if (skipNextBlur) {
      skipNextBlur = false;
      return;
    }
    void apply();
  };

  return (
    <div class={`min-w-0 ${props.class ?? ""}`}>
      <Input
        density="compact"
        ref={inputRef}
        aria-label={props.ariaLabel}
        aria-invalid={Boolean(error())}
        type="text"
        placeholder="0>360"
        class={`${PHASE_FIELD_CLASS} w-full ${error() ? "border-red-500" : ""}`}
        value={inputValue()}
        disabled={props.disabled || isApplying()}
        onInput={(event) => {
          setInputValue(event.currentTarget.value);
          setIsDirty(true);
          setError(undefined);
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      <Show when={error()}>
        {(message) => (
          <span class="mt-1 block text-[11px] text-red-400">{message()}</span>
        )}
      </Show>
    </div>
  );
}
