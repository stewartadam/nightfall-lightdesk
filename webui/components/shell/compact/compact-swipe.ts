// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Distance from either screen edge reserved for the browser's own back and forward swipes. */
const SCREEN_EDGE_GUARD = 24;
/** Minimum horizontal travel for a swipe, in CSS pixels. */
const MIN_DISTANCE = 64;
/** Horizontal travel must exceed vertical travel by this factor, so scrolling never switches panels. */
const MIN_DIRECTNESS = 1.6;
/** Longer gestures read as drags or reading pauses rather than flicks. */
const MAX_DURATION_MS = 600;

/**
 * Elements whose own gestures win over panel swiping: native controls, sliders
 * and faders, canvases such as the visualizer, and anything opted out with
 * `data-compact-swipe="off"`.
 */
const OWN_GESTURE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "canvas",
  "[contenteditable='true']",
  "[role='slider']",
  ".noUi-target",
  "[data-compact-swipe='off']",
  // Sheets and dialogs open over the panel; flicks inside them stay theirs.
  "dialog",
  "[role='dialog']",
].join(",");

/**
 * Returns whether an element between the target and the host handles
 * horizontal touch movement itself: it scrolls horizontally, or its
 * `touch-action` keeps horizontal panning for its own drag handling.
 */
function ownsHorizontalGesture(target: Element, host: Element): boolean {
  for (
    let element: Element | null = target;
    element && element !== host;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    const touchAction = style.touchAction;
    if (
      touchAction !== "auto" &&
      touchAction !== "manipulation" &&
      !touchAction.includes("pan-x")
    )
      return true;
    if (element.scrollWidth <= element.clientWidth + 1) continue;
    if (style.overflowX === "auto" || style.overflowX === "scroll") return true;
  }
  return false;
}

/**
 * Turns quick horizontal flicks inside `host` into panel steps: a flick to the
 * left shows the next panel and a flick to the right the previous one. Touches
 * that start near a screen edge, on a control with its own drag behavior, or
 * inside horizontally scrolling content are left alone. Listeners are passive,
 * so swiping never blocks scrolling.
 */
export function bindCompactSwipe(
  host: HTMLElement,
  step: (offset: number) => void,
): () => void {
  let start: { x: number; y: number; time: number } | undefined;

  /** Records a single-finger touch that is allowed to become a swipe. */
  const onTouchStart = (event: TouchEvent) => {
    start = undefined;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (
      touch.clientX < SCREEN_EDGE_GUARD ||
      touch.clientX > window.innerWidth - SCREEN_EDGE_GUARD
    )
      return;
    if (target.closest(OWN_GESTURE_SELECTOR)) return;
    if (ownsHorizontalGesture(target, host)) return;
    start = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
  };

  /** Steps between panels when the finished touch was a quick, mostly horizontal flick. */
  const onTouchEnd = (event: TouchEvent) => {
    const origin = start;
    start = undefined;
    const touch = event.changedTouches[0];
    if (!origin || !touch) return;
    const dx = touch.clientX - origin.x;
    const dy = touch.clientY - origin.y;
    if (
      Math.abs(dx) < MIN_DISTANCE ||
      Math.abs(dx) < Math.abs(dy) * MIN_DIRECTNESS ||
      event.timeStamp - origin.time > MAX_DURATION_MS
    )
      return;
    step(dx < 0 ? 1 : -1);
  };

  /** Drops a gesture the browser took over, such as a scroll or pinch. */
  const onTouchCancel = () => {
    start = undefined;
  };

  host.addEventListener("touchstart", onTouchStart, { passive: true });
  host.addEventListener("touchend", onTouchEnd, { passive: true });
  host.addEventListener("touchcancel", onTouchCancel, { passive: true });
  return () => {
    host.removeEventListener("touchstart", onTouchStart);
    host.removeEventListener("touchend", onTouchEnd);
    host.removeEventListener("touchcancel", onTouchCancel);
  };
}
