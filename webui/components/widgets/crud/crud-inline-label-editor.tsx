// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, type JSX, Show } from "solid-js";

export interface CrudInlineLabelEditorProps {
  ariaLabel: string;
  class?: string;
  editing: boolean;
  label: string;
  onCancel: () => void;
  onCommit: (label: string) => void;
  children: JSX.Element;
}

/** Renders a CRUD card label as text or an inline input while rename is active. */
export default function CrudInlineLabelEditor(
  props: CrudInlineLabelEditorProps,
) {
  let inputRef: HTMLInputElement | undefined;
  let closed = false;
  const [draftLabel, setDraftLabel] = createSignal("");

  /** Keeps the draft aligned with the backing label until this editor is active. */
  createEffect(() => {
    if (props.editing && document.activeElement === inputRef) return;
    setDraftLabel(props.label);
  });

  /** Focuses and selects the label when card rename starts. */
  createEffect(() => {
    if (!props.editing) return;
    closed = false;
    setDraftLabel(props.label);
    requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  });

  /** Commits the current draft and leaves inline rename mode. */
  const commit = () => {
    if (closed) return;
    closed = true;
    props.onCommit(draftLabel());
    props.onCancel();
  };

  /** Leaves inline rename mode without sending a label update. */
  const cancel = () => {
    if (closed) return;
    closed = true;
    props.onCancel();
  };

  return (
    <Show
      when={props.editing}
      fallback={<span class={props.class}>{props.children}</span>}
    >
      <input
        ref={inputRef}
        type="text"
        aria-label={props.ariaLabel}
        class="crud-inline-label-input min-w-0 flex-1 rounded border border-blue-400 bg-neutral-950 px-1 py-0.5 text-sm font-medium text-neutral-100 outline-none"
        value={draftLabel()}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onInput={(event) => setDraftLabel(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      />
    </Show>
  );
}
