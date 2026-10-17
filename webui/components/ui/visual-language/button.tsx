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

export interface ButtonProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "secondary" | "primary" | "subtle" | "danger";
  size?: "standard" | "compact" | "icon";
  /**
   * Help text shown in the shared tooltip on hover and keyboard focus. When it
   * differs from the accessible name it is also exposed as the accessible
   * description, as a native `title` would be.
   */
  tooltip?: string;
  /** Layout classes for the tooltip trigger wrapper; see `Tooltip`'s `class`. */
  tooltipClass?: string;
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
      class={`nf-button ${local.variant ?? "secondary"} ${local.class ?? ""}`}
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
