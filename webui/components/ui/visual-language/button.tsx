// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, splitProps } from "solid-js";
import "./button.css";
import "../button-feedback.css";

export interface ButtonProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "secondary" | "primary" | "subtle" | "danger";
  size?: "standard" | "compact" | "icon";
}

/** Renders a shared action variant while preserving native button semantics, refs and events. */
export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["class", "type", "variant", "size"]);
  return (
    <button
      type={local.type ?? "button"}
      class={`nf-button ${local.variant ?? "secondary"} ${local.class ?? ""}`}
      data-size={local.size}
      {...rest}
    />
  );
}
