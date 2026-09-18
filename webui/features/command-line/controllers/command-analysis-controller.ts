// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { type Accessor, createSignal, onCleanup, type Setter } from "solid-js";
import {
  isIntentSuggestion,
  type RankedCommandIntentSuggestion,
  type RankedCommandSuggestion,
  type RankedCommandTokenSuggestion,
} from "../../../lib/command-autocomplete";
import { validateCommandSemantics } from "../../../lib/command-semantic-validation";
import { validateCommand } from "../../../lib/wasm-bridge";
import { $ioSettings } from "../../../state/settings";
import type {
  CommandValidationSeverity,
  CommandValidationState,
} from "../components/command-validation-status";
import {
  analyzeCommandAutocomplete,
  analyzeCommandValidation,
} from "../services/command-analysis";

const AUTOCOMPLETE_DEBOUNCE_MS = 60;
const VALIDATION_DEBOUNCE_MS = 350;

interface IntentSublistState {
  intentId: string;
  label: string;
  options: RankedCommandTokenSuggestion[];
  parentIndex: number;
}

interface CommandAnalysisControllerOptions {
  input: Accessor<string>;
  setInput: Setter<string>;
  getInputElement: () => HTMLInputElement | undefined;
}

/** Owns command autocomplete and validation state independently of panel rendering. */
export function createCommandAnalysisController(
  options: CommandAnalysisControllerOptions,
) {
  const settings = useStore($ioSettings);
  const [suggestions, setSuggestions] = createSignal<RankedCommandSuggestion[]>(
    [],
  );
  const [suggestionIndex, setSuggestionIndex] = createSignal(0);
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false);
  const [intentSublist, setIntentSublist] =
    createSignal<IntentSublistState | null>(null);
  const [currentBreadcrumbLabel, setCurrentBreadcrumbLabel] = createSignal<
    string | null
  >(null);
  const [autocompleteArmed, setAutocompleteArmed] = createSignal(false);
  const [validationState, setValidationState] =
    createSignal<CommandValidationState>("idle");
  const [validationSeverity, setValidationSeverity] =
    createSignal<CommandValidationSeverity>("warning");
  const [validationError, setValidationError] = createSignal<string | null>(
    null,
  );
  const [validationTooltipForcedOpen, setValidationTooltipForcedOpen] =
    createSignal(false);
  const [submitShakeActive, setSubmitShakeActive] = createSignal(false);
  let autocompleteDebounceId: number | undefined;
  let validationDebounceId: number | undefined;
  let validationTooltipTimeoutId: number | undefined;
  let submitShakeTimeoutId: number | undefined;
  let autocompleteRequestId = 0;
  let validationRequestId = 0;

  /** Clears all autocomplete results and nested intent navigation. */
  const clearSuggestions = () => {
    setSuggestions([]);
    setSuggestionIndex(0);
    setSuggestionsOpen(false);
    setIntentSublist(null);
    setCurrentBreadcrumbLabel(null);
  };

  /** Returns the currently displayed root suggestions or intent options. */
  const visibleSuggestions = (): RankedCommandSuggestion[] =>
    intentSublist()?.options ?? suggestions();

  /** Reports whether a token suggestion may be inserted with Tab. */
  const isTabCompletableTokenSuggestion = (
    suggestion: RankedCommandTokenSuggestion,
  ) => suggestion.completable;

  /** Opens the token choices belonging to an intent suggestion. */
  const openIntentSublist = (
    suggestion: RankedCommandIntentSuggestion,
    parentIndex: number,
  ) => {
    if (suggestion.tokenOptions.length === 0) return;
    setIntentSublist({
      intentId: suggestion.intentId,
      label: suggestion.label,
      options: suggestion.tokenOptions,
      parentIndex,
    });
    setSuggestionIndex(0);
    setSuggestionsOpen(true);
  };

  /** Cancels any forced-open validation tooltip. */
  const clearValidationTooltipAutoOpen = () => {
    if (validationTooltipTimeoutId !== undefined) {
      clearTimeout(validationTooltipTimeoutId);
      validationTooltipTimeoutId = undefined;
    }
    setValidationTooltipForcedOpen(false);
  };

  /** Resets validation feedback to the requested non-error state. */
  const clearValidation = (nextState: CommandValidationState = "idle") => {
    setValidationError(null);
    setValidationState(nextState);
    if (nextState !== "invalid") setValidationSeverity("warning");
  };

  /** Temporarily exposes validation details after a rejected submission. */
  const triggerValidationTooltipAutoOpen = () => {
    clearValidationTooltipAutoOpen();
    setValidationTooltipForcedOpen(true);
    validationTooltipTimeoutId = window.setTimeout(() => {
      validationTooltipTimeoutId = undefined;
      setValidationTooltipForcedOpen(false);
    }, 2500);
  };

  /** Temporarily animates the input after a rejected submission. */
  const triggerSubmitShake = () => {
    if (submitShakeTimeoutId !== undefined) clearTimeout(submitShakeTimeoutId);
    setSubmitShakeActive(true);
    submitShakeTimeoutId = window.setTimeout(() => {
      submitShakeTimeoutId = undefined;
      setSubmitShakeActive(false);
    }, 320);
  };

  /** Refreshes autocomplete results while discarding stale async responses. */
  const refreshAutocomplete = async (value: string, cursor: number) => {
    const requestId = ++autocompleteRequestId;
    const analysis = await analyzeCommandAutocomplete(value, cursor);
    if (requestId !== autocompleteRequestId) return;
    if (!analysis) {
      clearSuggestions();
      return;
    }
    setSuggestions(analysis.suggestions);
    setCurrentBreadcrumbLabel(analysis.breadcrumbLabel);
    if (analysis.autoExpandTarget) {
      setIntentSublist({
        intentId: analysis.autoExpandTarget.intentId,
        label: analysis.autoExpandTarget.label,
        options: analysis.autoExpandTarget.tokenOptions,
        parentIndex: 0,
      });
      setSuggestionIndex(0);
    } else {
      setIntentSublist(null);
      setSuggestionIndex(analysis.selectedIndex);
    }
    setSuggestionsOpen(analysis.suggestions.length > 0);
  };

  /** Refreshes typing-time validation while discarding stale responses. */
  const refreshValidation = async (value: string) => {
    const requestId = ++validationRequestId;
    setValidationState("pending");
    const result = await analyzeCommandValidation(value, settings());
    if (requestId !== validationRequestId) return;
    if (result.status === "valid") {
      clearValidation("valid");
      return;
    }
    setValidationState("invalid");
    setValidationError(result.message);
    setValidationSeverity(result.severity);
  };

  /** Debounces autocomplete work for the current input and cursor. */
  const scheduleAutocomplete = (value: string, cursor: number) => {
    if (autocompleteDebounceId !== undefined)
      clearTimeout(autocompleteDebounceId);
    if (!value.trim()) {
      clearSuggestions();
      return;
    }
    autocompleteDebounceId = window.setTimeout(() => {
      void refreshAutocomplete(value, cursor);
    }, AUTOCOMPLETE_DEBOUNCE_MS);
  };

  /** Debounces semantic validation for the current command text. */
  const scheduleValidation = (value: string) => {
    if (validationDebounceId !== undefined) clearTimeout(validationDebounceId);
    if (!value.trim()) {
      clearValidation();
      clearValidationTooltipAutoOpen();
      return;
    }
    validationDebounceId = window.setTimeout(() => {
      void refreshValidation(value);
    }, VALIDATION_DEBOUNCE_MS);
  };

  /** Produces replacement text and cursor position for a token suggestion. */
  const applySuggestionText = (
    currentInput: string,
    suggestion: RankedCommandTokenSuggestion,
  ): { next: string; nextCursor: number } => {
    const requestedStart = Math.min(
      suggestion.replace.start,
      suggestion.replace.end,
      currentInput.length,
    );
    const requestedEnd = Math.min(
      Math.max(suggestion.replace.start, suggestion.replace.end),
      currentInput.length,
    );
    const prefix = currentInput.slice(0, requestedStart);
    const inserted = suggestion.applyText;
    return {
      next: prefix + inserted + currentInput.slice(requestedEnd),
      nextCursor: prefix.length + inserted.length,
    };
  };

  /** Applies a token suggestion and schedules analysis of the updated command. */
  const applySuggestion = (suggestion: RankedCommandTokenSuggestion) => {
    const { next, nextCursor } = applySuggestionText(
      options.input(),
      suggestion,
    );
    options.setInput(next);
    setAutocompleteArmed(true);
    setIntentSublist(null);
    clearValidation("idle");
    queueMicrotask(() => {
      const inputElement = options.getInputElement();
      inputElement?.focus();
      inputElement?.setSelectionRange(nextCursor, nextCursor);
    });
    scheduleAutocomplete(next, nextCursor);
    scheduleValidation(next);
  };

  /** Moves the active autocomplete selection by a wrapping offset. */
  const selectSuggestion = (offset: number) => {
    const entries = visibleSuggestions();
    if (entries.length === 0) return;
    setSuggestionIndex(
      (suggestionIndex() + offset + entries.length) % entries.length,
    );
  };

  /** Returns from an intent option list to its parent suggestion. */
  const closeIntentSublist = () => {
    const currentSublist = intentSublist();
    if (!currentSublist) return false;
    const intentIndex = suggestions().findIndex(
      (candidate) =>
        isIntentSuggestion(candidate) &&
        candidate.intentId === currentSublist.intentId,
    );
    setIntentSublist(null);
    setSuggestionIndex(
      intentIndex >= 0 ? intentIndex : currentSublist.parentIndex,
    );
    return true;
  };

  /** Handles autocomplete navigation keys and reports whether it consumed them. */
  const handleKeyDown = (event: KeyboardEvent) => {
    const entries = visibleSuggestions();
    if (!(suggestionsOpen() && entries.length > 0)) return false;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      selectSuggestion(event.key === "ArrowUp" ? -1 : 1);
      event.preventDefault();
      return true;
    }
    if (event.key === "Tab") {
      if (event.shiftKey) {
        closeIntentSublist();
        event.preventDefault();
        return true;
      }
      const selected = entries[suggestionIndex()];
      if (selected && isIntentSuggestion(selected)) {
        const singleton = selected.hasInlinePlaceholder
          ? undefined
          : selected.tokenOptions.find(
              (candidate) =>
                candidate.candidateId === selected.autoAdvanceCandidateId &&
                isTabCompletableTokenSuggestion(candidate),
            );
        if (singleton) applySuggestion(singleton);
        else openIntentSublist(selected, suggestionIndex());
      } else if (selected && isTabCompletableTokenSuggestion(selected)) {
        applySuggestion(selected);
      }
      event.preventDefault();
      return true;
    }
    if (event.key === "Escape") {
      if (!closeIntentSublist()) clearSuggestions();
      event.preventDefault();
      return true;
    }
    return false;
  };

  /** Updates analysis state when the user edits command text. */
  const onInputChange = (element: HTMLInputElement) => {
    options.setInput(element.value);
    setAutocompleteArmed(true);
    clearValidation("idle");
    clearValidationTooltipAutoOpen();
    queueMicrotask(() => {
      const value = element.value;
      scheduleAutocomplete(value, element.selectionStart ?? value.length);
      scheduleValidation(value);
    });
  };

  /** Recomputes autocomplete results after the input cursor moves. */
  const onCursorChange = (element: HTMLInputElement) => {
    if (!autocompleteArmed()) return;
    const value = element.value;
    setIntentSublist(null);
    scheduleAutocomplete(value, element.selectionStart ?? value.length);
  };

  /** Closes transient autocomplete state when command input loses focus. */
  const onInputBlur = () => {
    setSuggestionsOpen(false);
    setAutocompleteArmed(false);
  };

  /** Validates a submitted command and exposes blocking feedback on failure. */
  const validateSubmission = async (value: string) => {
    if (autocompleteDebounceId !== undefined)
      clearTimeout(autocompleteDebounceId);
    if (validationDebounceId !== undefined) clearTimeout(validationDebounceId);
    autocompleteDebounceId = undefined;
    validationDebounceId = undefined;
    const validation = await validateCommand(value);
    let error: string | undefined;
    if (validation?.status === "error") {
      error = validation.message ?? "Invalid command.";
    } else if (validation?.status === "ok") {
      const semantic = await validateCommandSemantics(value, settings());
      if (semantic.status === "error") error = semantic.message;
    }
    if (!error) return true;
    setValidationState("invalid");
    setValidationSeverity("error");
    setValidationError(error);
    triggerSubmitShake();
    triggerValidationTooltipAutoOpen();
    queueMicrotask(() => options.getInputElement()?.focus());
    return false;
  };

  /** Cancels pending analysis and clears transient state after submission. */
  const reset = () => {
    if (autocompleteDebounceId !== undefined)
      clearTimeout(autocompleteDebounceId);
    if (validationDebounceId !== undefined) clearTimeout(validationDebounceId);
    autocompleteDebounceId = undefined;
    validationDebounceId = undefined;
    autocompleteRequestId += 1;
    validationRequestId += 1;
    setAutocompleteArmed(false);
    clearSuggestions();
    clearValidation();
    clearValidationTooltipAutoOpen();
  };

  onCleanup(() => {
    if (autocompleteDebounceId !== undefined)
      clearTimeout(autocompleteDebounceId);
    if (validationDebounceId !== undefined) clearTimeout(validationDebounceId);
    if (validationTooltipTimeoutId !== undefined)
      clearTimeout(validationTooltipTimeoutId);
    if (submitShakeTimeoutId !== undefined) clearTimeout(submitShakeTimeoutId);
  });

  return {
    suggestions,
    suggestionIndex,
    suggestionsOpen,
    intentSublist,
    currentBreadcrumbLabel,
    validationState,
    validationSeverity,
    validationError,
    validationTooltipForcedOpen,
    submitShakeActive,
    visibleSuggestions,
    setSuggestionIndex,
    openIntentSublist,
    applySuggestion,
    clearSuggestions,
    clearValidation,
    clearValidationTooltipAutoOpen,
    scheduleValidation,
    setAutocompleteArmed,
    handleKeyDown,
    onInputChange,
    onCursorChange,
    onInputBlur,
    validateSubmission,
    reset,
  };
}
