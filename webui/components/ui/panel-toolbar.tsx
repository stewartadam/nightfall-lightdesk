// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, splitProps } from "solid-js";
import "./toolbar.css";

interface PanelToolbarProps extends JSX.HTMLAttributes<HTMLDivElement> {
  left?: JSX.Element;
  right?: JSX.Element;
  leftClass?: string;
  rightClass?: string;
  position?: "header" | "footer";
}

/** Arranges panel actions into shared wrapping left and right groups. */
export default function PanelToolbar(props: PanelToolbarProps) {
  const [local, rest] = splitProps(props, [
    "left",
    "right",
    "leftClass",
    "rightClass",
    "class",
    "position",
  ]);
  return (
    <div
      class={`nf-panel-toolbar ${local.class ?? ""}`}
      data-component="PanelToolbar"
      data-position={local.position}
      {...rest}
    >
      <div class={`nf-toolbar-group ${local.leftClass ?? ""}`} data-slot="left">
        {local.left}
      </div>
      <div
        class={`nf-toolbar-group ${local.rightClass ?? ""}`}
        data-slot="right"
      >
        {local.right}
      </div>
    </div>
  );
}

/** Visually separates related action groups without entering the keyboard focus order. */
export function ToolbarSeparator() {
  return <div class="nf-toolbar-separator" aria-hidden="true" />;
}
