// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, type JSX, Show, splitProps } from "solid-js";
import Tooltip from "../tooltip";
import "./button.css";
import "../button-feedback.css";

/** Visual emphasis of a shared button. */
export type ButtonVariant = "secondary" | "primary" | "subtle" | "danger";
/** Density of a shared button, applied through its `data-size` attribute. */
export type ButtonSize =
  | "standard"
  | "compact"
  | "icon"
  | "icon-compact"
  | "icon-inline"
  | "inline";

export interface ButtonProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Help text shown in the shared tooltip on hover and keyboard focus. When it
   * differs from the accessible name it is also exposed as the accessible
   * description, as a native `title` would be.
   */
  tooltip?: string;
  /** Layout classes for the tooltip trigger wrapper; see `Tooltip`'s `class`. */
  tooltipClass?: string;
  /**
   * Turns the button into its own progress bar: the accent color fills it from left to right.
   * Leave out `max` while the total is unknown to show activity instead of an amount.
   */
  progress?: ButtonProgress;
  /**
   * Every label the button may show, such as "Install" and "Installing…". The button keeps
   * the widest one's size, so swapping labels never moves what sits beside it.
   */
  reserveLabels?: string[];
}

/** How far along the work a button stands for is, for `ButtonProps.progress`. */
export interface ButtonProgress {
  /** Accessible name of the progress bar, such as "Download progress". */
  label: string;
  value?: number;
  max?: number | null;
  "data-testid"?: string;
}

/** Fill width as a percentage, or undefined while the total is unknown. */
function progressPercent(progress: ButtonProgress): number | undefined {
  if (!progress.max || progress.max <= 0) return undefined;
  return Math.min(
    100,
    Math.max(0, ((progress.value ?? 0) / progress.max) * 100),
  );
}

/** The accent fill drawn behind a button's label, exposed as a progress bar. */
function ButtonProgressFill(props: { progress: ButtonProgress }) {
  const percent = () => progressPercent(props.progress);
  return (
    <span
      class="nf-button-progress"
      role="progressbar"
      aria-label={props.progress.label}
      aria-valuemin={0}
      aria-valuemax={percent() === undefined ? undefined : 100}
      aria-valuenow={
        percent() === undefined ? undefined : Math.round(percent() as number)
      }
      data-indeterminate={percent() === undefined ? "" : undefined}
      data-testid={props.progress["data-testid"]}
      style={percent() === undefined ? undefined : { width: `${percent()}%` }}
    />
  );
}

/**
 * Builds the class list that gives a native button the shared action look.
 * Pair it with `data-size` for non-standard sizes; components that must own
 * their `<button>` element (such as menu triggers) use this to stay in sync
 * with `Button`.
 */
export function buttonClass(variant?: ButtonVariant, extra?: string): string {
  return `nf-button ${variant ?? "secondary"} ${extra ?? ""}`.trim();
}

/** Renders a shared action variant while preserving native button semantics, refs and events. */
export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, [
    "class",
    "type",
    "variant",
    "size",
    "tooltip",
    "tooltipClass",
    "progress",
    "reserveLabels",
    "children",
  ]);

  /** Returns the tooltip text when it adds information beyond the accessible name. */
  const description = () =>
    local.tooltip !== undefined && local.tooltip !== rest["aria-label"]
      ? local.tooltip
      : undefined;

  /**
   * The label, stacked over hidden copies of every reserved label so the button sizes to the
   * widest of them.
   */
  const content = () => (
    <Show when={local.reserveLabels?.length} fallback={local.children}>
      <span class="nf-button-label-stack">
        <span>{local.children}</span>
        <For each={local.reserveLabels}>
          {(label) => <span aria-hidden="true">{label}</span>}
        </For>
      </span>
    </Show>
  );

  /** Builds the native button; called once by whichever branch renders. */
  const button = () => (
    <button
      type={local.type ?? "button"}
      class={buttonClass(local.variant, local.class)}
      data-size={local.size}
      data-progress={local.progress ? "" : undefined}
      aria-busy={local.progress ? true : rest["aria-busy"]}
      aria-description={description()}
      {...rest}
    >
      <Show when={local.progress}>
        {(progress) => <ButtonProgressFill progress={progress()} />}
      </Show>
      {content()}
    </button>
  );

  return (
    <Show when={local.tooltip !== undefined} fallback={button()}>
      <Tooltip content={() => local.tooltip} class={local.tooltipClass}>
        {button()}
      </Tooltip>
    </Show>
  );
}
