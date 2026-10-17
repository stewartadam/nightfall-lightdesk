// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { SpinnerGapIcon } from "@squidlab/phosphor-solid/spinner-gap";
import { children, type JSX, Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AppIcon } from "./icon";

/**
 * Where the empty state sits:
 * - `panel` fills the available panel space and centers its content.
 * - `inline` is a muted line inside a list, menu or inspector.
 * - `dashed` is a bordered placeholder area, such as a drop target or an empty section.
 */
export type EmptyStateVariant = "panel" | "inline" | "dashed";

export interface EmptyStateProps
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "title" | "children"> {
  /** Layout and framing; defaults to `panel`. */
  variant?: EmptyStateVariant;
  /** Main message, such as "No FX selected". Defaults to "Loading…" while `loading`. */
  title?: JSX.Element;
  /** Secondary guidance beneath the title, such as how to create the first item. */
  description?: JSX.Element;
  /** Decorative icon shown before (inline) or above (panel, dashed) the text. */
  icon?: AppIcon;
  /** Optional call to action, such as a `Button`, shown beneath the text. */
  action?: JSX.Element;
  /**
   * Shows a spinning indicator in place of `icon` and marks the element as a polite
   * `role="status"` live region. Reduced motion stops the spin.
   */
  loading?: boolean;
  /** `compact` uses smaller text and padding for menus, popovers and tables. */
  density?: "standard" | "compact";
  /** Horizontal alignment of an `inline` empty state; the other variants always center. */
  align?: "start" | "center";
}

/** Classes for the outer element of each variant. */
const VARIANT_CLASSES: Record<EmptyStateVariant, string> = {
  panel:
    "flex h-full min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center",
  inline: "flex items-center gap-2",
  dashed:
    "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-neutral-700 text-center",
};

/**
 * Renders a consistent "nothing here" or "loading" message: muted text in the shared neutral
 * palette, with optional icon, guidance and action. Callers pick the variant that matches the
 * surrounding surface and keep their own outer spacing (for example `class="p-4"` in an inspector).
 */
export function EmptyState(props: EmptyStateProps) {
  const [local, rest] = splitProps(props, [
    "variant",
    "title",
    "description",
    "icon",
    "action",
    "loading",
    "density",
    "align",
    "class",
  ]);
  const variant = () => local.variant ?? "panel";
  const compact = () => local.density === "compact";
  /** Spinner while loading, otherwise the caller's icon (if any). */
  const icon = (): AppIcon | undefined =>
    local.loading ? SpinnerGapIcon : local.icon;
  const resolvedTitle = children(() => local.title);
  const description = children(() => local.description);
  /** Caller title, falling back to a generic loading label while `loading`. */
  const title = () =>
    resolvedTitle() ?? (local.loading ? "Loading…" : undefined);

  /** Outer classes combining variant layout, density and the caller's own classes. */
  const rootClass = () => {
    const parts = [
      VARIANT_CLASSES[variant()],
      compact() ? "text-xs" : "text-sm",
      "text-neutral-500",
    ];
    if (variant() === "dashed") parts.push(compact() ? "px-3 py-3" : "p-5");
    if (variant() === "inline" && local.align === "center") {
      parts.push("justify-center text-center");
    }
    if (local.class) parts.push(local.class);
    return parts.join(" ");
  };

  return (
    <div
      role={local.loading ? "status" : undefined}
      {...rest}
      class={rootClass()}
      data-empty-state={variant()}
    >
      <Show when={icon()}>
        {(Icon) => (
          <Dynamic
            component={Icon()}
            aria-hidden="true"
            class={`shrink-0 text-neutral-500 ${
              local.loading ? "animate-spin motion-reduce:animate-none" : ""
            } ${variant() === "inline" || compact() ? "size-4" : "size-6"}`}
          />
        )}
      </Show>
      <span
        class={
          variant() === "inline"
            ? "block min-w-0"
            : "flex flex-col items-center"
        }
      >
        <Show when={title()}>
          <span
            class={
              variant() === "panel" && description()
                ? "block font-medium text-neutral-400"
                : "block"
            }
          >
            {title()}
          </span>
        </Show>
        <Show when={description()}>
          <span class={`block max-w-sm ${title() ? "mt-1" : ""}`}>
            {description()}
          </span>
        </Show>
      </span>
      <Show when={local.action}>
        <div class={variant() === "inline" ? "ms-auto" : "mt-1"}>
          {local.action}
        </div>
      </Show>
    </div>
  );
}
