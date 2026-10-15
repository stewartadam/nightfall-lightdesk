// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import "./toggle-switch.css";

/**
 * Where the switch sits relative to its label: `switch-right` follows the label (the default),
 * `switch-left` precedes it, `switch-end` pushes it to the far edge of a full-width row, and
 * `switch-only` hides the visible label, leaving `ariaLabel` to name the switch.
 */
export type ToggleSwitchLayout =
  | "switch-right"
  | "switch-left"
  | "switch-end"
  | "switch-only";

interface ToggleSwitchProps {
  ariaLabel: string;
  /** Id for the switch input, so a label elsewhere, such as a settings row title, can name it. */
  id?: string;
  /** Id of the element describing the switch, such as a settings row description. */
  describedBy?: string;
  checked: boolean;
  disabled?: boolean;
  /** Visible label; omitted with the `switch-only` layout. */
  label?: string;
  /** Placement of the switch relative to its label. Default: `switch-right`. */
  layout?: ToggleSwitchLayout;
  /** Classes for the label text, such as heading typography when the switch titles a section. */
  labelClass?: string;
  class?: string;
  onChange: (enabled: boolean) => void;
}

/**
 * Renders an accent-aware native switch with a visible label and keyboard focus on its track.
 * Content that belongs to a `switch-left` switch can line up with its label text by adding the
 * `nf-switch-label-inset` class. For a setting with a title and description, place a
 * `switch-only` switch in a `SettingsRow`.
 */
export function ToggleSwitch(props: ToggleSwitchProps) {
  return (
    <label
      class={`nf-switch ${props.class ?? ""}`}
      data-layout={props.layout ?? "switch-right"}
      data-disabled={props.disabled ? "true" : undefined}
    >
      <Show when={props.layout !== "switch-only" && props.label}>
        {(text) => (
          <span class={`nf-switch-label ${props.labelClass ?? ""}`}>
            {text()}
          </span>
        )}
      </Show>
      <span class="nf-switch-control">
        <input
          type="checkbox"
          role="switch"
          checked={props.checked}
          disabled={props.disabled}
          aria-checked={props.checked}
          aria-label={props.ariaLabel}
          id={props.id}
          aria-describedby={props.describedBy}
          onChange={(event) => props.onChange(event.currentTarget.checked)}
        />
        <span aria-hidden="true" class="nf-switch-track" />
        <span aria-hidden="true" class="nf-switch-thumb" />
      </span>
    </label>
  );
}
