// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, splitProps } from "solid-js";
import Tooltip from "./tooltip";
import "./toolbar.css";
import "./button-feedback.css";

export const TOOLBAR_BUTTON_CLASS = "nf-toolbar-button";

interface ToolbarButtonProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tooltip?: string;
  variant?: "neutral" | "danger";
  size?: "icon" | "labeled";
  ariaPressed?: boolean;
}

interface ToggleToolbarButtonProps extends ToolbarButtonProps {
  pressed: boolean;
}

/** Provides shared toolbar states and a tooltip, with an independently named accessible action. */
export function ToolbarButton(props: ToolbarButtonProps) {
  const [local, rest] = splitProps(props, [
    "label",
    "tooltip",
    "variant",
    "size",
    "ariaPressed",
    "class",
    "type",
  ]);
  return (
    <Tooltip content={() => local.tooltip ?? local.label}>
      <button
        type={local.type ?? "button"}
        class={`${TOOLBAR_BUTTON_CLASS} ${local.class ?? ""}`}
        data-component="ToolbarButton"
        data-variant={local.variant}
        data-size={local.size}
        aria-label={local.label}
        aria-pressed={local.ariaPressed}
        {...rest}
      />
    </Tooltip>
  );
}

/** Exposes persistent toggle state through the shared toolbar presentation and aria-pressed. */
export function ToggleToolbarButton(props: ToggleToolbarButtonProps) {
  const [local, rest] = splitProps(props, ["pressed"]);
  return <ToolbarButton {...rest} ariaPressed={local.pressed} />;
}
