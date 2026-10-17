// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AppIcon } from "../icon";
import "./badge.css";

/** Semantic colors a badge can take; each maps onto a theme palette token in `badge.css`. */
export type BadgeTone =
  | "neutral"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "danger";

/** Visual weight: `outline` (tinted border), `soft` (tinted fill) or `solid` (full fill). */
export type BadgeAppearance = "outline" | "soft" | "solid";

/** Badge scale: `xs` for object tiles, `sm` for dense rows (the default), `md` for headings. */
export type BadgeSize = "xs" | "sm" | "md";

export interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  /** Semantic color. Defaults to `neutral`. */
  tone?: BadgeTone;
  /** Visual weight. Defaults to `outline`. */
  appearance?: BadgeAppearance;
  /** Text and padding scale. Defaults to `sm`. */
  size?: BadgeSize;
  /** Optional leading icon, sized to the badge text and hidden from assistive technology. */
  icon?: AppIcon;
  /** Renders the label in capitals with slight tracking, for status words. */
  uppercase?: boolean;
  /** Renders the label in the monospace font, for identifiers and counts. */
  mono?: boolean;
}

/**
 * Renders a small, non-interactive status or metadata label. Tone, appearance
 * and size are exposed as data attributes so `badge.css` owns every color,
 * radius and spacing rule; long labels truncate with an ellipsis instead of
 * growing their container.
 */
export function Badge(props: BadgeProps) {
  const [local, rest] = splitProps(props, [
    "tone",
    "appearance",
    "size",
    "icon",
    "uppercase",
    "mono",
    "class",
    "children",
  ]);
  return (
    <span
      class={`nf-badge ${local.class ?? ""}`.trim()}
      data-component="Badge"
      data-tone={local.tone ?? "neutral"}
      data-appearance={local.appearance ?? "outline"}
      data-size={local.size ?? "sm"}
      data-uppercase={local.uppercase ? "true" : undefined}
      data-mono={local.mono ? "true" : undefined}
      {...rest}
    >
      <Show when={local.icon}>
        {(Icon) => (
          <Dynamic
            component={Icon()}
            class="nf-badge-icon"
            weight="bold"
            aria-hidden="true"
          />
        )}
      </Show>
      <span class="nf-badge-label">{local.children}</span>
    </span>
  );
}

export interface CountBadgeProps
  extends Omit<JSX.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Number to show; nothing renders unless it is positive. */
  count: number | undefined;
  /** Semantic color of the bubble. Defaults to `info`. */
  tone?: BadgeTone;
  /** Largest number shown before collapsing to `{max}+`. Unlimited by default. */
  max?: number;
}

/**
 * Overlays a solid count bubble on the top-right corner of the nearest
 * positioned ancestor, so changing counts never resize or reflow the control
 * it decorates. The bubble ignores pointer events, leaving clicks to the
 * control underneath, and renders nothing for zero or missing counts.
 */
export function CountBadge(props: CountBadgeProps) {
  const [local, rest] = splitProps(props, ["count", "tone", "max", "class"]);
  /** Formats the count, collapsing values above `max` to a `max+` label. */
  const label = () => {
    const count = local.count ?? 0;
    return local.max !== undefined && count > local.max
      ? `${local.max}+`
      : String(count);
  };
  return (
    <Show when={(local.count ?? 0) > 0}>
      <span
        class={`nf-count-badge ${local.class ?? ""}`.trim()}
        data-component="CountBadge"
        data-tone={local.tone ?? "info"}
        {...rest}
      >
        {label()}
      </span>
    </Show>
  );
}
