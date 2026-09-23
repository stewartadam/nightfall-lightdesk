// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import Tooltip from "../../components/ui/tooltip";

interface GuideTargetProps {
  stepId: string;
  selector?: string;
  hint?: string;
  command?: string;
  paletteHint?: string;
  focusTarget?: boolean;
}

/** Highlights a visible control and optionally focuses it once when its lesson step begins. */
export function GuideTarget(props: GuideTargetProps) {
  const [bounds, setBounds] = createSignal<DOMRect | null>(null);
  const [inPalette, setInPalette] = createSignal(false);

  /** Re-resolves lazy panels and tracks scrolling, resizing, and dock rearrangement. */
  createEffect(() => {
    const selector = props.selector;
    const stepId = props.stepId;
    const focusTarget = props.focusTarget;
    void stepId;
    setBounds(null);
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
          const hit = document.elementFromPoint(x, y);
          return (
            hit !== null && (element.contains(hit) || hit.contains(element))
          );
        },
      );
      const rect = target?.getBoundingClientRect() ?? null;
      setInPalette(
        Boolean(target?.closest('[data-dialog-kind="command-palette"]')),
      );
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
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    onCleanup(() => {
      window.clearInterval(timer);
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    });
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
              <Tooltip
                selectable
                surfaceClass="nf-guide-tooltip"
                content={() => (
                  <span class="block max-w-72 whitespace-normal">
                    {inPalette()
                      ? (props.paletteHint ?? props.hint)
                      : props.hint}
                    <Show when={props.command}>
                      <code class="nf-guide-command">{props.command}</code>
                    </Show>
                  </span>
                )}
                anchorRect={() => rect()}
                animationKey={() => props.stepId}
                forceVisible={() => true}
                position={
                  rect().bottom + 90 > window.innerHeight ? "top" : "bottom"
                }
              >
                {null}
              </Tooltip>
            </Show>
          </div>
        )}
      </Show>
    </Portal>
  );
}
