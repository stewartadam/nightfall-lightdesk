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

/** Highlights a visible control and optionally focuses it once when its lesson step begins. */
export function GuideTarget(props: GuideTargetProps) {
  const [bounds, setBounds] = createSignal<DOMRect | null>(null);

  /** Re-resolves lazy panels and tracks scrolling, resizing, and dock rearrangement. */
  createEffect(() => {
    const selector = props.selector;
    const stepId = props.stepId;
    const focusTarget = props.focusTarget;
    void stepId;
    setBounds(null);
    props.onBounds?.(null);
    if (!selector) return;
    let previous = "";
    let focused = false;
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
      const rect = target?.getBoundingClientRect() ?? null;
      if (target && focusTarget && !focused) {
        focused = true;
        focusFrame = requestAnimationFrame(() => {
          if (target.isConnected) target.focus({ preventScroll: true });
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
    /** Follows nested scrollers on the next frame rather than waiting for geometry polling. */
    const onScroll = () => {
      if (scrollFrame !== undefined) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = undefined;
        update();
      });
    };
    document.addEventListener("scroll", onScroll, true);
    const timer = window.setInterval(update, 250);
    onCleanup(() => {
      document.removeEventListener("scroll", onScroll, true);
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
