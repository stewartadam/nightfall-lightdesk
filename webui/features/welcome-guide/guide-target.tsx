// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SPDX-License-Identifier: MPL-2.0

import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";

interface GuideTargetProps {
  selector?: string;
  hint?: string;
}

/** Highlights a visible control without intercepting clicks or moving keyboard focus. */
export function GuideTarget(props: GuideTargetProps) {
  const [bounds, setBounds] = createSignal<DOMRect | null>(null);

  /** Re-resolves lazy panels and tracks scrolling, resizing, and dock rearrangement. */
  createEffect(() => {
    const selector = props.selector;
    setBounds(null);
    if (!selector) return;
    let previous = "";
    /** Ignores hidden, clipped, disabled, or modal-obscured controls. */
    const update = () => {
      const modal = document.querySelector(
        '[role="dialog"][aria-modal="true"]',
      );
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
          const hit = document.elementFromPoint(x, y);
          return (
            hit !== null && (element.contains(hit) || hit.contains(element))
          );
        },
      );
      const rect = target?.getBoundingClientRect() ?? null;
      const key = rect
        ? `${rect.x},${rect.y},${rect.width},${rect.height}`
        : "none";
      if (key !== previous) {
        previous = key;
        setBounds(rect);
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    onCleanup(() => window.clearInterval(timer));
  });

  return (
    <Portal>
      <Show when={bounds()}>
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
            <Show when={props.hint}>
              <div
                class="nf-guide-hint"
                style={{
                  left: `${Math.max(8, Math.min(window.innerWidth - 248, rect().left))}px`,
                  top: `${Math.max(8, rect().bottom + 76 > window.innerHeight ? rect().top - 70 : rect().bottom + 10)}px`,
                }}
              >
                {props.hint}
              </div>
            </Show>
          </div>
        )}
      </Show>
    </Portal>
  );
}
