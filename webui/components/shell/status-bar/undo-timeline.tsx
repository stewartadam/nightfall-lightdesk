// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { SearchPickerOption } from "../../ui/search-picker";
import {
  formatUndoTimelineAge,
  type UndoTimelineEntry,
  undoTimelineActionLabel,
  undoTimelineEntryKey,
} from "./model";

/** Renders one condensed undo or redo stack entry in the status-bar popout. */
export function UndoTimelineButton(props: {
  item: UndoTimelineEntry;
  ageMs: number;
  disabled: boolean;
  onSelect: (item: UndoTimelineEntry) => Promise<void>;
}) {
  /** Describes how selecting this point changes the undo history. */
  const actionLabel = () => undoTimelineActionLabel(props.item);
  return (
    <li>
      <SearchPickerOption
        density="compact"
        type="button"
        style={{
          display: "grid",
          "grid-template-columns": "5.25rem minmax(0, 1fr) 3.75rem",
          gap: "8px",
        }}
        disabled={props.disabled}
        aria-label={`${undoTimelineActionLabel(props.item)}: ${props.item.entry.description}`}
        data-action-label={actionLabel()}
        data-undo-timeline-kind={props.item.kind}
        data-stack-key={undoTimelineEntryKey(props.item)}
        data-stack-order={props.item.entry.order}
        onClick={() => void props.onSelect(props.item)}
      >
        <span class="font-mono text-[10px] text-gray-500">{actionLabel()}</span>
        <span class="truncate">{props.item.entry.description}</span>
        <span class="text-right text-[10px] text-gray-500">
          {formatUndoTimelineAge(props.ageMs)}
        </span>
      </SearchPickerOption>
    </li>
  );
}

/** Renders the red marker for the current state within the linear undo path. */
export function UndoTimelineCaret() {
  return (
    <li
      aria-current="true"
      aria-label="Current undo state"
      class="grid grid-cols-[5.25rem_minmax(0,1fr)_3.75rem] items-center gap-2 px-2 py-1"
    >
      <span class="flex justify-end">
        <span class="h-0 w-0 border-y-[5px] border-l-[8px] border-y-transparent border-l-red-500" />
      </span>
      <span class="h-px bg-red-500/80" />
      <span class="h-px bg-red-500/80" />
    </li>
  );
}
