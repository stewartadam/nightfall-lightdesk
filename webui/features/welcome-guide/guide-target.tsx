// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";

interface GuideTargetProps {
  stepId: string;
  selector?: string;
  focusTarget?: boolean;
  highlight?: boolean;
  onBounds?: (bounds: DOMRect | null) => void;
}

/**
 * Scrolls the nearest user-scrollable ancestor just enough to show an element it clips.
 * Unlike scrollIntoView, this never moves overflow-hidden layout containers such as the app shell.
 * Returns whether a scroll was applied.
 */
function revealInScroller(element: HTMLElement): boolean {
  for (
    let scroller = element.parentElement;
    scroller;
    scroller = scroller.parentElement
  ) {
    const style = getComputedStyle(scroller);
    const scrollsY =
      /(auto|scroll)/.test(style.overflowY) &&
      scroller.scrollHeight > scroller.clientHeight;
    const scrollsX =
      /(auto|scroll)/.test(style.overflowX) &&
      scroller.scrollWidth > scroller.clientWidth;
    if (!scrollsY && !scrollsX) continue;
    const view = scroller.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    let top = 0;
    let left = 0;
    if (scrollsY && rect.bottom > view.bottom)
      top = Math.min(rect.bottom - view.bottom, rect.top - view.top);
    else if (scrollsY && rect.top < view.top) top = rect.top - view.top;
    if (scrollsX && rect.right > view.right)
      left = Math.min(rect.right - view.right, rect.left - view.left);
    else if (scrollsX && rect.left < view.left) left = rect.left - view.left;
    if (top === 0 && left === 0) continue;
    scroller.scrollBy({ top, left });
    return true;
  }
  return false;
}

/** Highlights a visible control and optionally focuses it once when its lesson step begins. */
export function GuideTarget(props: GuideTargetProps) {
  const [bounds, setBounds] = createSignal<DOMRect | null>(null);
  const [targetFocused, setTargetFocused] = createSignal(false);

  /** Re-resolves lazy panels and tracks scrolling, resizing, and dock rearrangement. */
  createEffect(() => {
    const selector = props.selector;
    const stepId = props.stepId;
    const focusTarget = props.focusTarget;
    const reveal = props.highlight !== false;
    void stepId;
    setBounds(null);
    props.onBounds?.(null);
    if (!selector) return;
    let previous = "";
    let focused: HTMLElement | undefined;
    let revealed = false;
    let focusFrame: number | undefined;
    /** Ignores hidden, clipped, disabled, or modal-obscured controls. */
    const update = () => {
      const modal = [
        ...document.querySelectorAll<HTMLElement>(
          '.nf-dialog-backdrop, [role="dialog"][aria-modal="true"]',
        ),
      ].find((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          getComputedStyle(element).visibility !== "hidden"
        );
      });
      const target = [...document.querySelectorAll<HTMLElement>(selector)].find(
        (element) => {
          if (modal && !modal.contains(element)) return false;
          if (element.closest('[inert], [aria-hidden="true"], [disabled]'))
            return false;
          // A hidden child passes the hit test below through its visible ancestor.
          if (!element.checkVisibility({ visibilityProperty: true }))
            return false;
          const rect = element.getBoundingClientRect();
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            rect.bottom < 0 ||
            rect.top > window.innerHeight
          )
            return false;
          const x = Math.max(
            0,
            Math.min(window.innerWidth - 1, rect.left + rect.width / 2),
          );
          const y = Math.max(
            0,
            Math.min(window.innerHeight - 1, rect.top + rect.height / 2),
          );
          const hit = document
            .elementsFromPoint(x, y)
            .find((candidate) => !candidate.closest(".nf-guide-floating"));
          return (
            hit !== undefined &&
            (element.contains(hit) || hit.contains(element))
          );
        },
      );
      // Scroll a rendered but clipped target into view once per step, so users need not hunt for it.
      if (!target && reveal && !revealed) {
        for (const element of document.querySelectorAll<HTMLElement>(
          selector,
        )) {
          if (modal && !modal.contains(element)) continue;
          if (element.closest('[inert], [aria-hidden="true"], [disabled]'))
            continue;
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (revealInScroller(element)) {
            revealed = true;
            break;
          }
        }
      }
      const rect = target?.getBoundingClientRect() ?? null;
      // A focused text field already shows its own focus ring, so the pulse would only add noise.
      // Buttons keep the pulse, since programmatic focus doesn't always draw a ring on them.
      setTargetFocused(
        !!target &&
          document.activeElement === target &&
          target.matches('input, textarea, select, [contenteditable="true"]'),
      );
      // Focuses each new target once, so a step that moves through form fields follows along.
      if (target && focusTarget && focused !== target) {
        focused = target;
        // Waits a second frame so a dialog's own initial focus lands first and the guide's wins.
        focusFrame = requestAnimationFrame(() => {
          focusFrame = requestAnimationFrame(() => {
            // A dialog opened meanwhile owns focus; pulling it outside would dismiss it.
            const dialog = document.querySelector(
              '[role="dialog"][aria-modal="true"]',
            );
            if (target.isConnected && (!dialog || dialog.contains(target)))
              target.focus({ preventScroll: true });
          });
        });
      }
      const key = rect
        ? `${rect.x},${rect.y},${rect.width},${rect.height}`
        : "none";
      if (key !== previous) {
        previous = key;
        setBounds(rect);
        props.onBounds?.(rect);
      }
    };
    update();
    let scrollFrame: number | undefined;
    /** Follows nested scrollers and focus moves on the next frame rather than waiting for geometry polling. */
    const scheduleUpdate = () => {
      if (scrollFrame !== undefined) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = undefined;
        update();
      });
    };
    document.addEventListener("scroll", scheduleUpdate, true);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", scheduleUpdate);
    const timer = window.setInterval(update, 250);
    onCleanup(() => {
      document.removeEventListener("scroll", scheduleUpdate, true);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", scheduleUpdate);
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
      window.clearInterval(timer);
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    });
  });

  return (
    <Portal>
      <Show when={props.highlight !== false && bounds()}>
        {(rect) => (
          <div
            class="nf-guide-anchor"
            aria-hidden="true"
            data-testid="guide-target"
          >
            <div
              class="nf-guide-highlight"
              data-target-focused={targetFocused() ? "" : undefined}
              style={{
                left: `${rect().left - 4}px`,
                top: `${rect().top - 4}px`,
                width: `${rect().width + 8}px`,
                height: `${rect().height + 8}px`,
              }}
            />
          </div>
        )}
      </Show>
    </Portal>
  );
}
