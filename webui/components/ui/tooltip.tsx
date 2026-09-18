// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Accessor,
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";

export interface TooltipProps {
  /** Content shown in the tooltip. Can be reactive. */
  content: Accessor<JSX.Element>;
  /** The element to wrap with tooltip behavior. */
  children: JSX.Element;
  /** Delay before showing tooltip (ms). Default: 500 */
  delay?: number;
  /** Position of the tooltip. Default: "top" */
  position?: "top" | "bottom" | "left" | "right";
  /** Optional external anchor used when wrapping the hovered element is not possible. */
  anchorRect?: Accessor<DOMRect | undefined>;
  /** Optional value that restarts the enter animation when externally anchored content changes. */
  animationKey?: Accessor<unknown>;
  /** Force tooltip visibility (used for imperative auto-open cases). */
  forceVisible?: Accessor<boolean>;
  /** Allow pointer selection and controls inside the tooltip surface. */
  interactive?: boolean;
}

/**
 * Custom tooltip component that persists hover state even when content updates.
 * Unlike the native `title` attribute, this won't reset its hover timer when
 * reactive values inside the tooltip content change.
 */
export default function Tooltip(props: TooltipProps) {
  const [visible, setVisible] = createSignal(false);
  const [mounted, setMounted] = createSignal(false);
  const [renderedVisible, setRenderedVisible] = createSignal(false);
  const [tooltipStyle, setTooltipStyle] = createSignal<JSX.CSSProperties>({});
  const [pointerStyle, setPointerStyle] = createSignal<JSX.CSSProperties>({});
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let closeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let exitTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastAnimationKey: unknown;
  let triggerRef: HTMLSpanElement | undefined;
  let tooltipRef: HTMLSpanElement | undefined;

  const delay = () => props.delay ?? 500;

  const position = () => props.position ?? "top";

  const forceVisible = () => props.forceVisible?.() ?? false;

  const wantsVisible = () => visible() || forceVisible();
  const OFFSET_PX = 10;
  const VIEWPORT_PADDING_PX = 8;
  const POINTER_SIZE_PX = 8;
  const TOOLTIP_Z_INDEX = "2147483647";
  const EXIT_ANIMATION_MS = 90;
  const INTERACTIVE_CLOSE_DELAY_MS = 120;

  /** Clamps a numeric value within an inclusive range. */
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

  /** Clears the delayed hover-open timer when the trigger is abandoned. */
  const clearOpenTimer = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  /** Clears the grace period that lets pointer users enter interactive content. */
  const clearCloseTimer = () => {
    if (closeTimeoutId) {
      clearTimeout(closeTimeoutId);
      closeTimeoutId = null;
    }
  };

  /** Clears a pending unmount so a tooltip can reopen during its fade-out. */
  const clearExitTimer = () => {
    if (exitTimeoutId) {
      clearTimeout(exitTimeoutId);
      exitTimeoutId = null;
    }
  };

  /** Seeds fixed positioning before the browser measures the tooltip. */
  const resetTooltipPosition = () => {
    setTooltipStyle({
      position: "fixed",
      left: "-9999px",
      top: "-9999px",
      "z-index": TOOLTIP_Z_INDEX,
    });
  };

  /** Computes the pointer offset so it keeps aiming at the wrapped trigger. */
  const updatePointerPosition = (
    rect: DOMRect,
    clampedLeft: number,
    clampedTop: number,
    tooltipWidth: number,
    tooltipHeight: number,
  ) => {
    const pointerInset = POINTER_SIZE_PX;

    if (position() === "left" || position() === "right") {
      const triggerCenterY = rect.top + rect.height / 2;
      const pointerTop = clamp(
        triggerCenterY - clampedTop,
        pointerInset,
        Math.max(pointerInset, tooltipHeight - pointerInset),
      );
      setPointerStyle({
        top: `${pointerTop}px`,
      });
      return;
    }

    const triggerCenterX = rect.left + rect.width / 2;
    const pointerLeft = clamp(
      triggerCenterX - clampedLeft,
      pointerInset,
      Math.max(pointerInset, tooltipWidth - pointerInset),
    );
    setPointerStyle({
      left: `${pointerLeft}px`,
    });
  };

  /** Positions the tooltip near its trigger while keeping it inside the viewport. */
  const updateTooltipPosition = () => {
    const rect = props.anchorRect?.() ?? triggerRef?.getBoundingClientRect();
    if (!rect) return;
    const tooltipRect = tooltipRef?.getBoundingClientRect();
    const tooltipWidth = tooltipRect?.width ?? 0;
    const tooltipHeight = tooltipRect?.height ?? 0;
    let left = rect.left + rect.width / 2 - tooltipWidth / 2;
    let top = rect.top - OFFSET_PX - tooltipHeight;

    switch (position()) {
      case "top":
        left = rect.left + rect.width / 2 - tooltipWidth / 2;
        top = rect.top - OFFSET_PX - tooltipHeight;
        break;
      case "bottom":
        left = rect.left + rect.width / 2 - tooltipWidth / 2;
        top = rect.bottom + OFFSET_PX;
        break;
      case "left":
        left = rect.left - OFFSET_PX - tooltipWidth;
        top = rect.top + rect.height / 2 - tooltipHeight / 2;
        break;
      case "right":
        left = rect.right + OFFSET_PX;
        top = rect.top + rect.height / 2 - tooltipHeight / 2;
        break;
    }

    const maxLeft = Math.max(
      VIEWPORT_PADDING_PX,
      window.innerWidth - tooltipWidth - VIEWPORT_PADDING_PX,
    );
    const maxTop = Math.max(
      VIEWPORT_PADDING_PX,
      window.innerHeight - tooltipHeight - VIEWPORT_PADDING_PX,
    );
    const clampedLeft = clamp(left, VIEWPORT_PADDING_PX, maxLeft);
    const clampedTop = clamp(top, VIEWPORT_PADDING_PX, maxTop);

    setTooltipStyle({
      position: "fixed",
      left: `${clampedLeft}px`,
      top: `${clampedTop}px`,
      "z-index": TOOLTIP_Z_INDEX,
    });
    updatePointerPosition(
      rect,
      clampedLeft,
      clampedTop,
      tooltipWidth,
      tooltipHeight,
    );
  };

  /** Starts the delayed tooltip open interaction for pointer users. */
  const handleMouseEnter = () => {
    clearOpenTimer();
    clearCloseTimer();
    timeoutId = setTimeout(() => {
      timeoutId = null;
      resetTooltipPosition();
      setVisible(true);
    }, delay());
  };

  /** Closes after a short bridge delay when interactive content must remain reachable. */
  const handleMouseLeave = () => {
    clearOpenTimer();
    clearCloseTimer();
    if (!props.interactive) {
      setVisible(false);
      return;
    }
    closeTimeoutId = setTimeout(() => {
      closeTimeoutId = null;
      setVisible(false);
    }, INTERACTIVE_CLOSE_DELAY_MS);
  };

  /** Keeps an interactive tooltip visible while its surface is hovered. */
  const handleTooltipMouseEnter = () => {
    if (!props.interactive) return;
    clearCloseTimer();
    setVisible(true);
  };

  /** Begins closing after the pointer leaves interactive tooltip content. */
  const handleTooltipMouseLeave = () => {
    if (!props.interactive) return;
    handleMouseLeave();
  };

  /** Opens the tooltip immediately for keyboard focus. */
  const handleFocus = () => {
    clearOpenTimer();
    clearCloseTimer();
    if (!wantsVisible()) resetTooltipPosition();
    setVisible(true);
  };

  /** Returns whether focus moved between the trigger and interactive surface. */
  const retainsInteractiveFocus = (relatedTarget: EventTarget | null) => {
    if (!props.interactive || !(relatedTarget instanceof Node)) return false;
    return (
      Boolean(triggerRef?.contains(relatedTarget)) ||
      Boolean(tooltipRef?.contains(relatedTarget))
    );
  };

  /** Hides the keyboard tooltip after focus leaves the complete interaction. */
  const handleBlur = (event: FocusEvent) => {
    if (retainsInteractiveFocus(event.relatedTarget)) return;
    clearOpenTimer();
    clearCloseTimer();
    setVisible(false);
  };

  onCleanup(() => {
    clearOpenTimer();
    clearCloseTimer();
    clearExitTimer();
  });

  /** Keeps the tooltip mounted briefly after close so opacity can animate out. */
  createEffect(() => {
    if (wantsVisible()) {
      const animationKey = props.animationKey?.();
      if (animationKey !== undefined && animationKey !== lastAnimationKey) {
        lastAnimationKey = animationKey;
        setRenderedVisible(false);
        resetTooltipPosition();
      }
      clearExitTimer();
      setMounted(true);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          setRenderedVisible(true);
          updateTooltipPosition();
        }),
      );
      return;
    }

    lastAnimationKey = undefined;
    setRenderedVisible(false);
    if (!mounted()) return;
    clearExitTimer();
    exitTimeoutId = setTimeout(() => {
      exitTimeoutId = null;
      setMounted(false);
    }, EXIT_ANIMATION_MS);
  });

  /** Repositions visible tooltip content when the viewport or content changes. */
  createEffect(() => {
    if (!mounted() || !wantsVisible()) return;

    const handleViewportChange = () => updateTooltipPosition();
    const content = props.content();
    void content;
    resetTooltipPosition();
    requestAnimationFrame(updateTooltipPosition);

    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);

    onCleanup(() => {
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    });
  });

  return (
    <span
      ref={triggerRef}
      class="relative inline-block"
      data-component="Tooltip"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusIn={handleFocus}
      onFocusOut={handleBlur}
    >
      {props.children}
      <Show when={mounted()}>
        <Portal>
          <span
            ref={tooltipRef}
            style={tooltipStyle()}
            class="relative overflow-visible px-2 py-1 text-xs text-white bg-gray-800 border border-gray-600 rounded shadow-[var(--shadow-elevation-low)] whitespace-pre transition-[opacity,transform] duration-150 ease-out"
            classList={{
              "pointer-events-none": !props.interactive,
              "pointer-events-auto select-text": props.interactive,
              "opacity-100 scale-100": renderedVisible(),
              "opacity-0 scale-95": !renderedVisible(),
              "origin-bottom": position() === "top",
              "origin-top": position() === "bottom",
              "origin-right": position() === "left",
              "origin-left": position() === "right",
            }}
            data-slot="surface"
            role="tooltip"
            onMouseEnter={handleTooltipMouseEnter}
            onMouseLeave={handleTooltipMouseLeave}
            onFocusIn={handleFocus}
            onFocusOut={handleBlur}
          >
            {props.content()}
            <span
              aria-hidden="true"
              style={pointerStyle()}
              class="absolute h-0 w-0"
              classList={{
                "-bottom-[5px] -translate-x-1/2 border-x-[5px] border-t-[5px] border-x-transparent border-t-gray-800 drop-shadow-[0_1px_0_rgb(75_85_99)]":
                  position() === "top",
                "-top-[5px] -translate-x-1/2 border-x-[5px] border-b-[5px] border-x-transparent border-b-gray-800 drop-shadow-[0_-1px_0_rgb(75_85_99)]":
                  position() === "bottom",
                "-right-[5px] -translate-y-1/2 border-y-[5px] border-l-[5px] border-y-transparent border-l-gray-800 drop-shadow-[1px_0_0_rgb(75_85_99)]":
                  position() === "left",
                "-left-[5px] -translate-y-1/2 border-y-[5px] border-r-[5px] border-y-transparent border-r-gray-800 drop-shadow-[-1px_0_0_rgb(75_85_99)]":
                  position() === "right",
              }}
              data-slot="pointer"
            />
          </span>
        </Portal>
      </Show>
    </span>
  );
}
