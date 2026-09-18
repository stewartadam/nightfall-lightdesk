// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CheckIcon } from "@squidlab/phosphor-solid/check";
import { createMemo, For, Show } from "solid-js";
import { visualLanguageAccents } from "./accents";
import { Button } from "./button";
import "./accent-picker.css";

type Accent = (typeof visualLanguageAccents)[number];

interface AccentPickerProps {
  value: Accent["value"];
  onChange: (accent: Accent) => void;
}

/** Presents the shared spectrum as inset swatches with a named, checked selection. */
export function AccentPicker(props: AccentPickerProps) {
  /** Resolves the current accent name for the heading without repeating swatch labels. */
  const selectedName = createMemo(
    () =>
      visualLanguageAccents.find((accent) => accent.value === props.value)
        ?.name,
  );

  return (
    <fieldset class="nf-accent-picker">
      <legend>
        <span>Accent</span>
        <span class="nf-accent-name">{selectedName()}</span>
      </legend>
      <div class="nf-accent-options">
        <For each={visualLanguageAccents}>
          {(accent) => (
            <Button
              aria-label={`${accent.name} accent`}
              aria-pressed={props.value === accent.value}
              title={accent.name}
              style={{ "--swatch": accent.value }}
              onClick={() => props.onChange(accent)}
            >
              <span aria-hidden="true" />
              <Show when={props.value === accent.value}>
                <CheckIcon size={13} aria-hidden="true" />
              </Show>
            </Button>
          )}
        </For>
      </div>
    </fieldset>
  );
}
