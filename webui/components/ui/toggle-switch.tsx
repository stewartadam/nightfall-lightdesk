// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createUniqueId, Show } from "solid-js";
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
  checked: boolean;
  disabled?: boolean;
  /** Visible label; omitted with the `switch-only` layout. */
  label?: string;
  /** Placement of the switch relative to its label. Default: `switch-right`. */
  layout?: ToggleSwitchLayout;
  /** Classes for the label text, such as heading typography when the switch titles a section. */
  labelClass?: string;
  /**
   * Explanation shown beneath the label and announced as the switch's description. Pair it
   * with `switch-end` for a settings row: title and description on the left, switch centered
   * on the right. Plain text only, since it renders inside the switch's `<label>`, where links
   * and other interactive content are not allowed.
   */
  description?: string;
  class?: string;
  onChange: (enabled: boolean) => void;
}

/**
 * Renders an accent-aware native switch with a visible label and keyboard focus on its track.
 * Content that belongs to a `switch-left` switch can line up with its label text by adding the
 * `nf-switch-label-inset` class.
 */
export function ToggleSwitch(props: ToggleSwitchProps) {
  const descriptionId = createUniqueId();
  /** Label text, absent for `switch-only` switches and switches without a label. */
  const label = () => (
    <Show when={props.layout !== "switch-only" && props.label}>
      {(text) => (
        <span class={`nf-switch-label ${props.labelClass ?? ""}`}>
          {text()}
        </span>
      )}
    </Show>
  );
  return (
    <label
      class={`nf-switch ${props.class ?? ""}`}
      data-layout={props.layout ?? "switch-right"}
      data-disabled={props.disabled ? "true" : undefined}
    >
      <Show when={props.description} fallback={label()}>
        <span class="nf-switch-text">
          {label()}
          <span id={descriptionId} class="nf-switch-description">
            {props.description}
          </span>
        </span>
      </Show>
      <span class="nf-switch-control">
        <input
          type="checkbox"
          role="switch"
          checked={props.checked}
          disabled={props.disabled}
          aria-checked={props.checked}
          aria-label={props.ariaLabel}
          aria-describedby={props.description ? descriptionId : undefined}
          onChange={(event) => props.onChange(event.currentTarget.checked)}
        />
        <span aria-hidden="true" class="nf-switch-track" />
        <span aria-hidden="true" class="nf-switch-thumb" />
      </span>
    </label>
  );
}
