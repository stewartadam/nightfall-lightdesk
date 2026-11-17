// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, createUniqueId, For } from "solid-js";
import { Input } from "../../../components/ui/form-controls";
import { attributeSuggestions } from "../model/draft-editing";
import { CommitField, type CommitOutcome } from "./commit-field";
import { useDraftEditing } from "./draft-context";

/**
 * Suggests attribute names for a field: the standard GDTF attributes plus
 * any the fixture already defines. The field still takes any name, since a
 * fixture may define attributes of its own.
 */
function AttributeOptions(props: { id: string }) {
  const editing = useDraftEditing();
  /** Suggestions in catalog order, followed by the fixture's own attributes. */
  const options = createMemo(() =>
    attributeSuggestions(
      editing.attributeOptions(),
      editing.draft().attributes,
    ),
  );
  return (
    <datalist id={props.id}>
      <For each={options()}>
        {(option) => <option value={option.name}>{option.label}</option>}
      </For>
    </datalist>
  );
}

/** A free-text attribute field that reports every keystroke, for forms with their own submit. */
export default function AttributeField(props: {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
}) {
  const listId = createUniqueId();
  return (
    <>
      <Input
        density="compact"
        list={listId}
        autocomplete="off"
        spellcheck={false}
        value={props.value}
        placeholder={props.placeholder}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <AttributeOptions id={listId} />
    </>
  );
}

/** An attribute field that sends its value when editing finishes, like the draft's other fields. */
export function AttributeCommitField(props: {
  value: string;
  onCommit: (value: string) => CommitOutcome;
  "aria-label"?: string;
}) {
  const listId = createUniqueId();
  return (
    <>
      <CommitField
        list={listId}
        autocomplete="off"
        spellcheck={false}
        aria-label={props["aria-label"]}
        value={props.value}
        onCommit={(value) =>
          value.trim() ? props.onCommit(value.trim()) : false
        }
      />
      <AttributeOptions id={listId} />
    </>
  );
}
