// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ChatCenteredTextIcon } from "@squidlab/phosphor-solid/chat-centered-text";
import { InfoIcon } from "@squidlab/phosphor-solid/info";
import { LightbulbIcon } from "@squidlab/phosphor-solid/lightbulb";
import { WarningIcon } from "@squidlab/phosphor-solid/warning";
import { WarningOctagonIcon } from "@squidlab/phosphor-solid/warning-octagon";
import { type JSX, Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AppIcon } from "../icon";
import "./alert.css";

/** Alert kinds, matching the GitHub Markdown `[!NOTE]` … `[!CAUTION]` callouts. */
export type AlertVariant = "note" | "tip" | "important" | "warning" | "caution";

/** Default icon for each alert kind; the accent color comes from `alert.css`. */
const VARIANT_ICONS: Record<AlertVariant, AppIcon> = {
  note: InfoIcon,
  tip: LightbulbIcon,
  important: ChatCenteredTextIcon,
  warning: WarningIcon,
  caution: WarningOctagonIcon,
};

export interface AlertProps
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Alert kind; picks the accent color and default icon. Defaults to `note`. */
  variant?: AlertVariant;
  /** Optional bold heading shown on the first line, beside the icon. */
  title?: JSX.Element;
  /** Replaces the variant's icon, or hides it when `false`. */
  icon?: AppIcon | false;
  /** `compact` tightens padding and text for dense dialogs and properties. */
  density?: "standard" | "compact";
}

/**
 * Renders an inline, blockquote-style callout with a colored start border,
 * tinted background, icon and optional title. It carries no live-region role
 * by default; pass `role="alert"` for errors that appear in response to an
 * action, or `role="status"` for polite updates.
 */
export function Alert(props: AlertProps) {
  const [local, rest] = splitProps(props, [
    "variant",
    "title",
    "icon",
    "density",
    "class",
    "children",
  ]);
  /** Resolves the icon to draw, honoring an explicit override or opt-out. */
  const icon = () =>
    local.icon === false
      ? undefined
      : (local.icon ?? VARIANT_ICONS[local.variant ?? "note"]);
  return (
    <div
      class={`nf-alert ${local.class ?? ""}`}
      data-variant={local.variant ?? "note"}
      data-density={local.density ?? "standard"}
      {...rest}
    >
      <Show when={icon()}>
        {(Icon) => (
          <Dynamic
            component={Icon()}
            class="nf-alert-icon"
            weight="bold"
            aria-hidden="true"
          />
        )}
      </Show>
      <div class="nf-alert-body">
        <Show when={local.title}>
          <p class="nf-alert-title">{local.title}</p>
        </Show>
        {local.children}
      </div>
    </div>
  );
}
