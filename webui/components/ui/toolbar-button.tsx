// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, Show, splitProps } from "solid-js";
import Tooltip from "./tooltip";
import "./toolbar.css";
import "./button-feedback.css";

export const TOOLBAR_BUTTON_CLASS = "nf-toolbar-button";

/**
 * Toggle state is reserved for `ToggleToolbarButton`, so a momentary action
 * cannot announce itself as pressed, and help text goes through `tooltip`
 * rather than a native `title` that would double up with the shared tooltip.
 */
interface ToolbarButtonProps
  extends Omit<
    JSX.ButtonHTMLAttributes<HTMLButtonElement>,
    "aria-pressed" | "title"
  > {
  label: string;
  tooltip?: string;
  variant?: "neutral" | "danger";
  size?: "icon" | "labeled";
  /** Item count shown as a corner badge when positive, without resizing the button. */
  count?: number;
}

interface ToggleToolbarButtonProps extends ToolbarButtonProps {
  pressed: boolean;
}

/**
 * Provides shared toolbar states and a tooltip, with an independently named
 * accessible action. A positive `count` overlays a corner badge so selection
 * changes never reflow the toolbar.
 */
export function ToolbarButton(props: ToolbarButtonProps) {
  return <ToolbarButtonBase {...props} />;
}

/** Exposes persistent toggle state through the shared toolbar presentation and aria-pressed. */
export function ToggleToolbarButton(props: ToggleToolbarButtonProps) {
  return <ToolbarButtonBase {...props} />;
}

/**
 * Renders the shared toolbar button for both public variants. `pressed` is
 * only set by `ToggleToolbarButton`; when absent, no `aria-pressed` is
 * emitted and the button behaves as a momentary action.
 */
function ToolbarButtonBase(props: ToolbarButtonProps & { pressed?: boolean }) {
  const [local, rest] = splitProps(props, [
    "label",
    "tooltip",
    "variant",
    "size",
    "pressed",
    "class",
    "type",
    "count",
    "children",
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
        aria-pressed={local.pressed}
        {...rest}
      >
        {local.children}
        <Show when={(local.count ?? 0) > 0}>
          <span class="nf-toolbar-badge" aria-hidden="true">
            {local.count}
          </span>
        </Show>
      </button>
    </Tooltip>
  );
}
