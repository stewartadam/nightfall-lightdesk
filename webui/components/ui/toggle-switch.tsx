// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import "./toggle-switch.css";

interface ToggleSwitchProps {
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  class?: string;
  onChange: (enabled: boolean) => void;
}

/** Renders an accent-aware native switch with a visible label and keyboard focus on its track. */
export function ToggleSwitch(props: ToggleSwitchProps) {
  return (
    <label
      class={`nf-switch ${props.class ?? ""}`}
      data-disabled={props.disabled ? "true" : undefined}
    >
      <span class="nf-switch-label">{props.label}</span>
      <span class="nf-switch-control">
        <input
          type="checkbox"
          role="switch"
          checked={props.checked}
          disabled={props.disabled}
          aria-checked={props.checked}
          aria-label={props.ariaLabel}
          onChange={(event) => props.onChange(event.currentTarget.checked)}
        />
        <span aria-hidden="true" class="nf-switch-track" />
        <span aria-hidden="true" class="nf-switch-thumb" />
      </span>
    </label>
  );
}
