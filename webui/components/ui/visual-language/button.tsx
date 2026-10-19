// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, Show, splitProps } from "solid-js";
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
  ]);

  /** Returns the tooltip text when it adds information beyond the accessible name. */
  const description = () =>
    local.tooltip !== undefined && local.tooltip !== rest["aria-label"]
      ? local.tooltip
      : undefined;

  /** Builds the native button; called once by whichever branch renders. */
  const button = () => (
    <button
      type={local.type ?? "button"}
      class={buttonClass(local.variant, local.class)}
      data-size={local.size}
      aria-description={description()}
      {...rest}
    />
  );

  return (
    <Show when={local.tooltip !== undefined} fallback={button()}>
      <Tooltip content={() => local.tooltip} class={local.tooltipClass}>
        {button()}
      </Tooltip>
    </Show>
  );
}
