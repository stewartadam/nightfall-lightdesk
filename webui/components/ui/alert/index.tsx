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
import {
  type Accessor,
  createEffect,
  createSignal,
  type JSX,
  on,
  onCleanup,
  Show,
  splitProps,
} from "solid-js";
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
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "title" | "style"> {
  /** Alert kind; picks the accent color and default icon. Defaults to `note`. */
  variant?: AlertVariant;
  /** Optional bold heading shown on the first line, beside the icon. */
  title?: JSX.Element;
  /** Replaces the variant's icon, or hides it when `false`. */
  icon?: AppIcon | false;
  /** `compact` tightens padding and text for dense dialogs and properties. */
  density?: "standard" | "compact";
  /** Edge that carries the accent stripe: `left` (blockquote, the default), `top`, or `none`. */
  border?: "left" | "top" | "none";
  /**
   * Whether the alert is shown. Hiding plays the exit transition before the
   * alert unmounts. Defaults to `true`, or to `false` when `flash` is set so
   * the alert only appears while flashing.
   */
  show?: boolean;
  /**
   * Shows the alert for `flashMs` each time this value changes (not on mount),
   * restarting the period on every change. Use it for transient confirmations
   * such as "Saved" next to the control that triggered them.
   */
  flash?: Accessor<unknown>;
  /** How long each flash keeps the alert shown (ms), read when the flash starts. Default: 2000 */
  flashMs?: number;
  /** Enter/exit animation: `fade` (the default), `slide` (fade and drop in from above) or `none`. */
  transition?: "fade" | "slide" | "none";
  /** Enter/exit animation length in ms. Default: 150 */
  transitionMs?: number;
  /** Inline styles, merged with the transition duration the alert sets itself. */
  style?: JSX.CSSProperties;
}

/**
 * Renders an inline, blockquote-style callout with a colored accent border,
 * tinted background, icon and optional title. It carries no live-region role
 * by default; pass `role="alert"` for errors that appear in response to an
 * action, or `role="status"` for polite updates. Showing and hiding animate
 * with tw-animate-css and are skipped under reduced motion.
 */
export function Alert(props: AlertProps) {
  const [local, rest] = splitProps(props, [
    "variant",
    "title",
    "icon",
    "density",
    "border",
    "show",
    "flash",
    "flashMs",
    "transition",
    "transitionMs",
    "class",
    "style",
    "children",
  ]);
  const [flashing, setFlashing] = createSignal(false);
  let flashTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let exitTimeoutId: ReturnType<typeof setTimeout> | undefined;

  /** Shows the alert for the flash period whenever the flash value changes, skipping mount. */
  createEffect(
    on(
      () => local.flash?.(),
      () => {
        clearTimeout(flashTimeoutId);
        setFlashing(true);
        flashTimeoutId = setTimeout(
          () => setFlashing(false),
          local.flashMs ?? 2000,
        );
      },
      { defer: true },
    ),
  );

  /** Whether callers currently want the alert visible, through `show` or an active flash. */
  const wantsVisible = () => (local.show ?? !local.flash) || flashing();
  /** Effective animation length, collapsing to zero when transitions are disabled. */
  const transitionMs = () =>
    local.transition === "none" ? 0 : (local.transitionMs ?? 150);
  const [mounted, setMounted] = createSignal(wantsVisible());

  /** Mounts immediately on show and keeps the alert mounted until its exit animation finishes. */
  createEffect(
    on(
      wantsVisible,
      (visible) => {
        clearTimeout(exitTimeoutId);
        if (visible) {
          setMounted(true);
        } else if (transitionMs() === 0 || prefersReducedMotion()) {
          setMounted(false);
        } else {
          exitTimeoutId = setTimeout(() => setMounted(false), transitionMs());
        }
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    clearTimeout(flashTimeoutId);
    clearTimeout(exitTimeoutId);
  });

  /** tw-animate-css classes for the chosen transition; `data-state` swaps enter for exit. */
  const transitionClass = () =>
    ({
      fade: "animate-in fade-in fill-mode-both data-[state=closed]:animate-out data-[state=closed]:fade-out",
      slide:
        "animate-in fade-in slide-in-from-top-1 fill-mode-both data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:slide-out-to-top-1",
      none: "",
    })[local.transition ?? "fade"];

  /** Resolves the icon to draw, honoring an explicit override or opt-out. */
  const icon = () =>
    local.icon === false
      ? undefined
      : (local.icon ?? VARIANT_ICONS[local.variant ?? "note"]);
  return (
    <Show when={mounted()}>
      <div
        class={`nf-alert ${transitionClass()} ${local.class ?? ""}`}
        data-variant={local.variant ?? "note"}
        data-density={local.density ?? "standard"}
        data-border={local.border ?? "left"}
        data-state={wantsVisible() ? "open" : "closed"}
        style={{ ...local.style, "--tw-duration": `${transitionMs()}ms` }}
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
    </Show>
  );
}

/** Mirrors the app's reduced-motion preference, falling back to the OS setting when unset. */
function prefersReducedMotion(): boolean {
  const reduced = document.documentElement.dataset.reducedMotion;
  if (reduced === "true") return true;
  if (reduced === "false") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
