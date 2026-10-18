// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AppIcon } from "./icon";
import Tooltip from "./tooltip";
import "./segmented.css";
import "./segmented-control.css";

export interface SegmentedControlOption<T> {
  value: T;
  /** Visible text. Omit it for an icon-only option, which then needs `ariaLabel`. */
  label?: JSX.Element;
  icon?: AppIcon;
  /** Accessible name, replacing the visible label (required for icon-only options). */
  ariaLabel?: string;
  /** Help shown in a tooltip on hover or focus, and exposed as the option's description. */
  tooltip?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T> {
  /** Accessible name of the group. Omit it only when `aria-labelledby` names the group. */
  label?: string;
  options: readonly SegmentedControlOption<T>[];
  /** The selected value; `undefined` (or an unknown value) leaves every option unchecked. */
  value: T | undefined;
  onChange: (value: T) => void;
  density?: "compact" | "comfortable";
  /** Stretches the group to its container and shares the width equally between options. */
  fill?: boolean;
  disabled?: boolean;
  id?: string;
  class?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "data-testid"?: string;
}

/**
 * Picks one value from a small set of mutually exclusive options, following the
 * WAI-ARIA radio group pattern: the group is one Tab stop on the checked option,
 * and arrow keys move focus and select the adjacent enabled option, wrapping at
 * the ends. Home and End select the first or last enabled option.
 *
 * Inside a `Toolbar`, the group cooperates with the toolbar's roving focus: arrow
 * keys still select within the group, but at either end of the group they are
 * left to the toolbar so focus can move on to the neighboring control, and Home
 * and End jump to the toolbar's ends.
 */
export function SegmentedControl<T>(props: SegmentedControlProps<T>) {
  const radios: HTMLButtonElement[] = [];

  /** Returns whether an option can be focused and selected. */
  const enabled = (option: SegmentedControlOption<T>) =>
    !props.disabled && !option.disabled;

  /**
   * Index of the option that holds the group's Tab stop: the checked option when it
   * is enabled, otherwise the first enabled option, so a group without a usable
   * selection stays reachable from the keyboard.
   */
  const tabStop = () => {
    const checked = props.options.findIndex(
      (option) => option.value === props.value && enabled(option),
    );
    return checked >= 0 ? checked : props.options.findIndex(enabled);
  };

  /** Selects an enabled option and moves focus to it, as a radio group arrow key does. */
  function selectAt(index: number) {
    const option = props.options[index];
    if (!option || !enabled(option)) return;
    if (option.value !== props.value) props.onChange(option.value);
    radios[index]?.focus();
  }

  /**
   * Moves the selection with arrow, Home and End keys and claims each key it handles
   * with `preventDefault()`. Inside a toolbar, keys that would leave the group (an
   * arrow past either end, Home and End) are left unhandled for the toolbar.
   */
  function handleKeyDown(event: KeyboardEvent, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const target = event.currentTarget as HTMLElement;
    const inToolbar = target.closest('[role="toolbar"]') !== null;
    const order = props.options
      .map((option, optionIndex) => (enabled(option) ? optionIndex : -1))
      .filter((optionIndex) => optionIndex >= 0);
    const position = order.indexOf(index);
    if (position < 0) return;
    let next: number | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next =
          position + 1 < order.length
            ? order[position + 1]
            : inToolbar
              ? undefined
              : order[0];
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next =
          position > 0
            ? order[position - 1]
            : inToolbar
              ? undefined
              : order[order.length - 1];
        break;
      case "Home":
        next = inToolbar ? undefined : order[0];
        break;
      case "End":
        next = inToolbar ? undefined : order[order.length - 1];
        break;
      default:
        return;
    }
    if (next === undefined) return;
    event.preventDefault();
    selectAt(next);
  }

  return (
    <div
      id={props.id}
      class={`nf-segmented-control ${props.class ?? ""}`.trim()}
      role="radiogroup"
      aria-label={props.label}
      aria-labelledby={props["aria-labelledby"]}
      aria-describedby={props["aria-describedby"]}
      aria-disabled={props.disabled || undefined}
      data-density={props.density ?? "comfortable"}
      data-fill={props.fill ? "" : undefined}
      data-component="SegmentedControl"
      data-testid={props["data-testid"]}
    >
      <For each={props.options}>
        {(option, index) => {
          /** Renders the option itself, so it can be wrapped in a tooltip when it has help text. */
          const radio = () => (
            <button
              ref={(element) => {
                radios[index()] = element;
              }}
              type="button"
              role="radio"
              class="nf-segmented-control-item"
              aria-checked={option.value === props.value}
              aria-label={option.ariaLabel}
              aria-description={
                option.tooltip !== option.ariaLabel ? option.tooltip : undefined
              }
              data-icon-only={
                option.icon && option.label === undefined ? "" : undefined
              }
              disabled={!enabled(option)}
              tabIndex={index() === tabStop() ? 0 : -1}
              onClick={() => selectAt(index())}
              onKeyDown={(event) => handleKeyDown(event, index())}
            >
              <Show when={option.icon}>
                {(icon) => (
                  <Dynamic
                    component={icon()}
                    class="nf-segmented-control-icon"
                    aria-hidden="true"
                  />
                )}
              </Show>
              {option.label}
            </button>
          );
          return (
            <Show when={option.tooltip} fallback={radio()}>
              {(tooltip) => <Tooltip content={tooltip}>{radio()}</Tooltip>}
            </Show>
          );
        }}
      </For>
    </div>
  );
}
