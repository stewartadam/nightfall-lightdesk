// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Component,
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  Show,
  splitProps,
  untrack,
} from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { overlayHost } from "../modal/dialog-stack";

/** Space between the anchor and its popover. */
const POPOVER_GAP_PX = 4;
/** Closest a popover may come to the viewport edge. */
const POPOVER_EDGE_MARGIN_PX = 8;

const FOCUSABLE_POPOVER_CONTROL_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface PopoverProps
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "ref" | "style"> {
  /** Element the popover is positioned against and that never counts as an outside press. */
  anchor: () => Element | undefined;
  /** Whether the popover is shown; the caller owns this state. */
  open: boolean;
  /** Called on an outside pointer press or Escape; the caller closes the popover. */
  onClose: () => void;
  /**
   * Side of the anchor to open on. `auto` opens below unless the content does
   * not fit there and there is more room above. Defaults to `below`.
   */
  placement?: "above" | "below" | "auto";
  /** Which anchor edge the popover lines up with. Defaults to `start`. */
  align?: "start" | "end";
  /** Sizes the popover to the anchor's width, for pickers that extend a field. */
  matchAnchorWidth?: boolean;
  /**
   * Where focus goes on open: the first enabled control (`first`, the
   * default), nowhere (`none`, for pickers whose field keeps focus), or the
   * element a function returns.
   */
  initialFocus?: "first" | "none" | (() => HTMLElement | undefined);
  /** Element focused after Escape; defaults to the anchor. */
  returnFocus?: () => HTMLElement | undefined;
  /** Surface component rendered as the positioned element, such as `MenuSurface`. */
  surface?: Component<JSX.HTMLAttributes<HTMLDivElement>>;
  /** Receives the positioned element. */
  ref?: (element: HTMLDivElement) => void;
  /** Extra inline style merged after the computed position. */
  style?: JSX.CSSProperties;
  children?: JSX.Element;
}

/**
 * Renders floating content anchored to an element, mounted through
 * `overlayHost` so it stays visible and interactive above (or inside) open
 * modal dialogs. The popover owns positioning (flip, clamp to the viewport,
 * scroll when too tall), dismissal on outside pointer presses and Escape, and
 * initial focus. Its document listeners exist only while it is open.
 */
export function Popover(props: PopoverProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "anchor",
    "open",
    "onClose",
    "placement",
    "align",
    "matchAnchorWidth",
    "initialFocus",
    "returnFocus",
    "surface",
    "ref",
    "style",
    "class",
    "children",
  ]);
  const [position, setPosition] = createSignal<JSX.CSSProperties>({});
  let popoverRef: HTMLDivElement | undefined;

  /**
   * Places the popover against the anchor's current viewport bounds. It
   * scrolls when taller than the room on its side, and slides sideways when
   * its aligned edge would push it off screen.
   */
  const updatePosition = (): void => {
    const anchor = local.anchor();
    if (!anchor) return;
    const bounds = anchor.getBoundingClientRect();
    const roomBelow =
      window.innerHeight -
      bounds.bottom -
      POPOVER_GAP_PX -
      POPOVER_EDGE_MARGIN_PX;
    const roomAbove = bounds.top - POPOVER_GAP_PX - POPOVER_EDGE_MARGIN_PX;
    const placement = local.placement ?? "below";
    const contentHeight = popoverRef?.scrollHeight ?? 0;
    const below =
      placement === "below" ||
      (placement === "auto" &&
        (contentHeight <= roomBelow || roomBelow >= roomAbove));
    const vertical = below
      ? { top: `${bounds.bottom + POPOVER_GAP_PX}px` }
      : { bottom: `${window.innerHeight - bounds.top + POPOVER_GAP_PX}px` };
    const width = local.matchAnchorWidth
      ? bounds.width
      : (popoverRef?.offsetWidth ?? 0);
    const maxLeft = window.innerWidth - POPOVER_EDGE_MARGIN_PX - width;
    const anchoredLeft =
      local.align === "end" ? bounds.right - width : bounds.left;
    const left = Math.max(
      POPOVER_EDGE_MARGIN_PX,
      Math.min(anchoredLeft, maxLeft),
    );
    setPosition({
      ...vertical,
      left: `${left}px`,
      ...(local.matchAnchorWidth ? { width: `${width}px` } : {}),
      "max-height": `${Math.max(0, below ? roomBelow : roomAbove)}px`,
      "max-width": `calc(100vw - ${2 * POPOVER_EDGE_MARGIN_PX}px)`,
      "overflow-y": "auto",
    });
  };

  /** Moves focus into the opened popover as `initialFocus` asks. */
  const focusInitialControl = (): void => {
    const initial = local.initialFocus ?? "first";
    if (initial === "none") return;
    const target =
      initial === "first"
        ? popoverRef?.querySelector<HTMLElement>(
            FOCUSABLE_POPOVER_CONTROL_SELECTOR,
          )
        : initial();
    target?.focus();
  };

  /** Closes on a pointer press outside both the popover and its anchor. */
  const handlePointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (popoverRef?.contains(target) || local.anchor()?.contains(target)) {
      return;
    }
    local.onClose();
  };

  /** Closes on Escape and returns focus to the anchor or `returnFocus`. */
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    local.onClose();
    const anchor = local.anchor();
    const focusTarget =
      local.returnFocus?.() ??
      (anchor instanceof HTMLElement ? anchor : undefined);
    focusTarget?.focus();
  };

  /**
   * Installs dismissal and repositioning listeners for as long as the popover
   * is open, then places and focuses it once it has laid out.
   */
  createEffect(() => {
    if (!local.open) return;
    untrack(updatePosition);
    queueMicrotask(() => {
      updatePosition();
      focusInitialControl();
    });
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    });
  });

  return (
    <Show when={local.open}>
      <Portal mount={overlayHost(local.anchor())}>
        <Dynamic
          component={local.surface ?? "div"}
          ref={(element: HTMLDivElement) => {
            popoverRef = element;
            local.ref?.(element);
          }}
          data-component="Popover"
          class={`fixed nightfall-top-layer ${local.class ?? ""}`}
          style={{ ...position(), ...local.style }}
          {...rest}
        >
          {local.children}
        </Dynamic>
      </Portal>
    </Show>
  );
}
