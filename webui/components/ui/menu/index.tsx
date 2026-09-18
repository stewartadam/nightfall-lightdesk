// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CheckIcon } from "@squidlab/phosphor-solid/check";
import { type JSX, Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AppIcon } from "../icon";
import "./menu.css";

/** Provides the shared menu surface while callers control placement and dismissal. */
export function MenuSurface(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return <div class={`nf-menu ${local.class ?? ""}`} {...rest} />;
}

export interface MenuItemProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: AppIcon;
  checked?: boolean;
  danger?: boolean;
  shortcut?: string;
  trailing?: JSX.Element;
}

/** Aligns command labels, checkmarks, icons and hints across every menu entry point. */
export function MenuItem(props: MenuItemProps) {
  const [local, rest] = splitProps(props, [
    "class",
    "type",
    "children",
    "icon",
    "checked",
    "danger",
    "shortcut",
    "trailing",
  ]);
  return (
    <button
      type={local.type ?? "button"}
      class={`nf-menu-item ${local.class ?? ""}`}
      data-danger={local.danger || undefined}
      {...rest}
    >
      <span class="nf-menu-icon" aria-hidden="true">
        <Show
          when={local.checked}
          fallback={
            <Show when={local.icon}>
              {(icon) => <Dynamic component={icon()} />}
            </Show>
          }
        >
          <CheckIcon />
        </Show>
      </span>
      <span class="nf-menu-label">{local.children}</span>
      <Show when={local.shortcut}>
        <span class="nf-menu-hint">{local.shortcut}</span>
      </Show>
      <Show when={local.trailing}>
        <span class="nf-menu-hint" aria-hidden="true">
          {local.trailing}
        </span>
      </Show>
    </button>
  );
}

/** Separates related action groups with the same spacing in dropdowns and flyouts. */
export function MenuSeparator(props: JSX.HTMLAttributes<HTMLHRElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return <hr class={`nf-menu-separator ${local.class ?? ""}`} {...rest} />;
}

/** Labels a group of commands without behaving like an actionable row. */
export function MenuHeading(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return <div class={`nf-menu-heading ${local.class ?? ""}`} {...rest} />;
}
