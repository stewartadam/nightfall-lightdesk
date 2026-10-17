// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  splitProps,
} from "solid-js";
import { Input } from "./form-controls";
import "./inline-rename-field.css";

/** Why an inline rename ended: a saved or no-op commit, or a discarded draft. */
export type InlineRenameCloseReason = "commit" | "cancel";

/** Elements that can take focus back once the editor closes from the keyboard. */
const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export interface InlineRenameFieldProps
  extends Omit<
    JSX.InputHTMLAttributes<HTMLInputElement>,
    | "value"
    | "onInput"
    | "onChange"
    | "onKeyDown"
    | "onClose"
    | "onBlur"
    | "ref"
    | "aria-label"
    | "type"
  > {
  /** Saved name the draft starts from and is compared against. */
  value: string;
  /** Accessible name of the field. */
  ariaLabel: string;
  /**
   * Saves a changed name. Runs only when the normalized draft differs from `value` and passes the
   * empty check. Returning `false` or rejecting keeps the editor open with the draft (the caller
   * reports why); the field is read-only while a returned promise is pending.
   */
  onCommit: (value: string) => unknown;
  /** Ends editing; the caller unmounts the field in response. */
  onClose: (reason: InlineRenameCloseReason) => void;
  /** Accepts an empty name as a real rename instead of restoring the saved one. */
  allowEmpty?: boolean;
  /** Keeps leading and trailing whitespace instead of trimming it before comparing and saving. */
  preserveWhitespace?: boolean;
  /** Controlled draft for editors whose field remounts while editing continues. */
  draft?: string;
  /** Receives each draft change when the draft is controlled. */
  onDraftChange?: (draft: string) => void;
  /** Receives the mounted input element. */
  ref?: (element: HTMLInputElement) => void;
  /** Picks the element that regains focus after Enter or Escape closes the editor. */
  returnFocus?: () => HTMLElement | null | undefined;
}

/**
 * Edits a name in place: Enter or leaving the field saves, Escape restores the saved name. Mount it
 * while editing and unmount it from `onClose`. It focuses itself and selects the name on mount,
 * keeps Enter and Escape away from dialogs and panel shortcuts, and returns focus to the element
 * that started the edit (or the nearest focusable neighbor) when the keyboard closes it.
 */
export function InlineRenameField(props: InlineRenameFieldProps) {
  const [local, rest] = splitProps(props, [
    "value",
    "ariaLabel",
    "onCommit",
    "onClose",
    "allowEmpty",
    "preserveWhitespace",
    "draft",
    "onDraftChange",
    "ref",
    "returnFocus",
    "class",
    "readOnly",
  ]);
  let inputRef: HTMLInputElement | undefined;
  let host: HTMLElement | null = null;
  let previouslyFocused: HTMLElement | null = null;
  let closed = false;
  let disposed = false;
  const [localDraft, setLocalDraft] = createSignal(local.value);
  const [pending, setPending] = createSignal(false);

  /** Returns the controlled draft when supplied, else the field's own draft. */
  const draft = () => local.draft ?? localDraft();

  /** Stores a draft change in the controlled owner or the local signal. */
  const updateDraft = (next: string) => {
    if (local.onDraftChange) local.onDraftChange(next);
    if (local.draft === undefined) setLocalDraft(next);
  };

  /** Applies whitespace normalization before comparing or saving the draft. */
  const normalized = () =>
    local.preserveWhitespace ? draft() : draft().trim();

  /** Focuses the field, selecting an untouched name or placing the caret after an edited draft. */
  const focusField = () => {
    if (!inputRef || closed) return;
    inputRef.focus({ preventScroll: true });
    if (draft() === local.value) {
      inputRef.select();
    } else {
      const end = inputRef.value.length;
      inputRef.setSelectionRange(end, end);
    }
  };

  /** Puts focus back near the edited name when closing from the keyboard left nothing focused. */
  const restoreFocus = () => {
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const target =
        local.returnFocus?.() ??
        (previouslyFocused?.isConnected ? previouslyFocused : null) ??
        (host?.isConnected
          ? (host.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
            host.closest<HTMLElement>(FOCUSABLE_SELECTOR))
          : null);
      target?.focus({ preventScroll: true });
    });
  };

  /** Ends editing once, optionally handing focus back to the editing context. */
  const close = (reason: InlineRenameCloseReason, fromKeyboard: boolean) => {
    closed = true;
    local.onClose(reason);
    if (fromKeyboard) restoreFocus();
  };

  /** Reopens a failed commit so the draft can be corrected or cancelled. */
  const reopenAfterFailure = (fromKeyboard: boolean) => {
    setPending(false);
    closed = false;
    if (fromKeyboard && !disposed) focusField();
  };

  /** Saves a changed draft, treating unchanged or disallowed empty drafts as a restore. */
  const commit = (fromKeyboard: boolean) => {
    if (closed || pending()) return;
    const next = normalized();
    if (next === local.value || (next.length === 0 && !local.allowEmpty)) {
      close(next === local.value ? "commit" : "cancel", fromKeyboard);
      return;
    }
    closed = true;
    let result: unknown;
    try {
      result = local.onCommit(next);
    } catch (error) {
      reopenAfterFailure(fromKeyboard);
      throw error;
    }
    if (result instanceof Promise) {
      setPending(true);
      result.then(
        (outcome) => {
          if (outcome === false) {
            reopenAfterFailure(fromKeyboard);
            return;
          }
          setPending(false);
          close("commit", fromKeyboard && !disposed);
        },
        () => reopenAfterFailure(fromKeyboard),
      );
      return;
    }
    if (result === false) {
      reopenAfterFailure(fromKeyboard);
      return;
    }
    close("commit", fromKeyboard);
  };

  /** Discards the draft and restores the saved name. */
  const cancel = () => {
    if (closed || pending()) return;
    close("cancel", true);
  };

  /** Commits when focus leaves for another element, ignoring window switches and unmounts. */
  const handleBlur = () => {
    if (closed || disposed || pending()) return;
    if (inputRef && document.activeElement === inputRef) return;
    commit(false);
  };

  /** Handles Enter and Escape locally and keeps every key away from panel shortcuts. */
  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commit(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  /** Records where focus came from and focuses the field, retrying if a closing menu reclaims focus. */
  onMount(() => {
    const active = document.activeElement;
    previouslyFocused =
      active instanceof HTMLElement && active !== document.body ? active : null;
    host = inputRef?.parentElement ?? null;
    focusField();
    requestAnimationFrame(() => {
      if (!disposed && document.activeElement !== inputRef) focusField();
    });
  });

  /** Stops removal-triggered blur events from committing after the field unmounts. */
  onCleanup(() => {
    disposed = true;
  });

  /** Stops pointer and mouse events from selecting, dragging or reopening the surrounding item. */
  const stop = (event: Event) => event.stopPropagation();

  return (
    <Input
      {...rest}
      ref={(element) => {
        inputRef = element;
        local.ref?.(element);
      }}
      type="text"
      density="compact"
      data-owns-dialog-keys=""
      aria-label={local.ariaLabel}
      aria-busy={pending() ? "true" : undefined}
      readOnly={pending() || local.readOnly}
      class={`nf-inline-rename-field select-text ${local.class ?? ""}`}
      value={draft()}
      draggable={false}
      onInput={(event) => updateDraft(event.currentTarget.value)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onClick={stop}
      onDblClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onContextMenu={stop}
    />
  );
}
