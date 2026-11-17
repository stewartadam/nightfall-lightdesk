// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo } from "solid-js";
import {
  AutocompleteField,
  type AutocompleteFieldProps,
  type AutocompleteOption,
} from "../../../components/ui/autocomplete-field";
import { attributeSuggestions } from "../model/draft-editing";
import { type CommitOutcome, createCommitText } from "./commit-field";
import { useDraftEditing } from "./draft-context";

/**
 * A text field that suggests attribute names: the standard GDTF attributes, each described by
 * its group and readable name, plus any the fixture already defines. It still takes any name,
 * since a fixture may define attributes of its own.
 */
function AttributeInput(
  props: Omit<
    AutocompleteFieldProps,
    "options" | "density" | "spellcheck" | "listLabel"
  >,
) {
  const editing = useDraftEditing();
  /** Suggestions in catalog order, followed by the fixture's own attributes. */
  const options = createMemo<AutocompleteOption[]>(() =>
    attributeSuggestions(
      editing.attributeOptions(),
      editing.draft().attributes,
    ).map((option) => ({ value: option.name, description: option.label })),
  );
  return (
    <AutocompleteField
      {...props}
      density="compact"
      spellcheck={false}
      listLabel="Attributes"
      options={options()}
    />
  );
}

/** A free-text attribute field that reports every keystroke, for forms with their own submit. */
export default function AttributeField(props: {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <AttributeInput
      value={props.value}
      placeholder={props.placeholder}
      onInput={props.onInput}
      onPick={props.onInput}
    />
  );
}

/** An attribute field that sends its value when editing finishes, like the draft's other fields. */
export function AttributeCommitField(props: {
  value: string;
  onCommit: (value: string) => CommitOutcome;
  "aria-label"?: string;
}) {
  const field = createCommitText({
    get value() {
      return props.value;
    },
    onCommit: (value) => (value.trim() ? props.onCommit(value.trim()) : false),
  });
  return (
    <AttributeInput
      aria-label={props["aria-label"]}
      value={field.text()}
      onInput={field.type}
      onPick={field.choose}
      onKeyDown={field.handleKey}
      onBlur={field.commit}
    />
  );
}
