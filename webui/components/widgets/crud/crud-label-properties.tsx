// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, Show } from "solid-js";
import { Input } from "../../ui/form-controls";

export interface CrudLabelPropertiesProps<T> {
  entry: T | null | undefined;
  entityName: string;
  getId: (entry: T) => string | number;
  getLabel: (entry: T) => string;
  onLabelCommit?: (entry: T, label: string) => void;
}

/** Renders shared Properties-panel label editing for selected CRUD entries. */
export default function CrudLabelProperties<T>(
  props: CrudLabelPropertiesProps<T>,
) {
  let inputRef: HTMLInputElement | undefined;
  let previousEntryId: string | number | undefined;
  const [draftLabel, setDraftLabel] = createSignal("");

  /** Synchronizes local draft text from the selected entry unless the user is typing. */
  createEffect(() => {
    const entry = props.entry;
    if (!entry) {
      previousEntryId = undefined;
      setDraftLabel("");
      return;
    }
    const entryId = props.getId(entry);
    const selectionChanged = previousEntryId !== entryId;
    previousEntryId = entryId;
    if (document.activeElement === inputRef && !selectionChanged) return;
    setDraftLabel(props.getLabel(entry));
  });

  /** Commits a changed draft label to the owning CRUD panel. */
  const commitLabel = () => {
    const entry = props.entry;
    if (!entry || !props.onLabelCommit) return;
    const nextLabel = draftLabel();
    if (nextLabel === props.getLabel(entry)) return;
    props.onLabelCommit(entry, nextLabel);
  };

  /** Restores the draft label from the selected entry without sending an update. */
  const resetLabel = () => {
    const entry = props.entry;
    setDraftLabel(entry ? props.getLabel(entry) : "");
  };

  return (
    <Show
      when={props.entry}
      fallback={
        <div class="p-4 text-sm text-neutral-500">
          Select one {props.entityName.toLowerCase()} to edit its label.
        </div>
      }
    >
      {(entry) => (
        <div class="space-y-4 p-4">
          <div class="border-b border-neutral-700 pb-3">
            <h3 class="font-medium text-neutral-100">
              {props.entityName} {props.getId(entry())}
            </h3>
            <p class="text-xs text-neutral-400">
              {props.getLabel(entry()) || "Untitled"}
            </p>
          </div>

          <label class="block text-xs font-medium text-neutral-300">
            Label
            <Input
              density="compact"
              ref={inputRef}
              type="text"
              aria-label={`${props.entityName} label`}
              class="mt-1"
              value={draftLabel()}
              disabled={!props.onLabelCommit}
              onInput={(event) => setDraftLabel(event.currentTarget.value)}
              onBlur={commitLabel}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitLabel();
                  event.currentTarget.blur();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  resetLabel();
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
        </div>
      )}
    </Show>
  );
}
