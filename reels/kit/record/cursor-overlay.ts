// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Options for one animated cursor move, in CSS pixels and milliseconds. */
export interface CursorMoveOptions {
  /** Total travel time; derived from the distance when omitted. */
  durationMs?: number;
  /** Fraction of the travel distance the cursor overshoots before settling. */
  overshoot?: number;
  /** Travels in a straight line instead of a wrist arc, as a drag does. */
  straight?: boolean;
}

/** Where the cursor was at one moment, as wall-clock epoch milliseconds and CSS pixels. */
export interface CursorSample {
  epochMs: number;
  x: number;
  y: number;
}

/** Everything the cursor did during a take, for the edit to draw. */
export interface CursorTrack {
  /** The cursor's position each time it moved, in order. */
  samples: CursorSample[];
  /** Each click, at the cursor's position when it happened. */
  clicks: CursorSample[];
}

/** Browser-side API the overlay installs on `window.__reelCursor`. */
export interface ReelCursorApi {
  moveTo(x: number, y: number, options?: CursorMoveOptions): Promise<void>;
  /** Logs a click at the cursor's position, for the edit to draw a press and a ripple. */
  ripple(): Promise<void>;
  position(): { x: number; y: number };
  /** The cursor's moves and clicks so far. */
  track(): CursorTrack;
  /**
   * Adds an element that rides along with the pointer, drawn just under it in
   * the overlay, such as a file being dragged in. Returns a function that
   * removes it.
   */
  carry(element: HTMLElement, offset: { x: number; y: number }): () => void;
}

/**
 * Installs a fake cursor that glides along curved, eased paths with a slight
 * overshoot and logs each click. Headless captures never show the system
 * pointer, and real pointer moves teleport, so the recording script animates
 * this cursor first and fires the real input once it arrives.
 *
 * The page never paints the arrow or the click ripple. It only logs where the
 * cursor was on each animation frame, and the edit draws it from that log,
 * sharp at any zoom. A cursor drawn in the page also froze the take for a
 * quarter second per glide (see "Screencast lock-in" in the README).
 * Elements handed to `carry`, such as a file chip being dragged in, stay
 * visible and ride along in the page.
 *
 * Runs in the page through `page.addInitScript`, so it must stay
 * self-contained: no imports or closures over module scope.
 */
export function installReelCursor(): void {
  const start = { x: window.innerWidth * 0.62, y: window.innerHeight * 0.78 };
  let current = { ...start };
  let host: HTMLDivElement | undefined;
  let pointer: HTMLDivElement | undefined;
  /** Every position the cursor took and every click, for the edit to redraw. */
  const track: CursorTrack = { samples: [], clicks: [] };

  /** The current wall-clock time in epoch milliseconds, at sub-millisecond precision. */
  function epochMs(): number {
    return performance.timeOrigin + performance.now();
  }
  /** Elements riding along with the pointer, with their offset from its tip. */
  const carried: { element: HTMLElement; offset: { x: number; y: number } }[] =
    [];

  /** Creates the overlay once the document body exists. */
  function ensureHost(): HTMLDivElement {
    if (host?.isConnected) return host;
    host = document.createElement("div");
    host.setAttribute("data-reel-cursor", "true");
    host.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;";
    // An empty anchor that carried elements stack under; the edit draws the arrow.
    pointer = document.createElement("div");
    pointer.style.cssText =
      "position:absolute;left:0;top:0;width:0;height:0;visibility:hidden;";
    host.append(pointer);
    // A manual popover lives in the browser's top layer, so modal dialogs and
    // their backdrops can't cover or dim the cursor.
    host.popover = "manual";
    host.style.cssText +=
      "margin:0;padding:0;border:0;background:transparent;width:100vw;height:100vh;max-width:none;max-height:none;";
    document.documentElement.append(host);
    host.showPopover();
    new MutationObserver(raise).observe(document.documentElement, {
      subtree: true,
      attributeFilter: ["open"],
    });
    place(current);
    return host;
  }

  /**
   * Moves the overlay back to the top of the top layer. Each modal dialog that
   * opens stacks above every earlier top-layer element, the overlay included,
   * so the overlay shows itself again after it.
   */
  function raise(): void {
    if (!host?.isConnected) return;
    host.hidePopover();
    host.showPopover();
  }

  /** Logs the cursor's tip at the given point and moves carried elements along with it. */
  function place(point: { x: number; y: number }): void {
    track.samples.push({ epochMs: epochMs(), x: point.x, y: point.y });
    for (const { element, offset } of carried) {
      element.style.transform = `translate3d(${point.x + offset.x}px, ${point.y + offset.y}px, 0)`;
    }
  }

  /** Smooth ease-in-out whose tail overshoots by `amount` and settles back. */
  function easeWithOvershoot(t: number, amount: number): number {
    const inOut = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    // A sine bump peaking near 85% of the move gives the overshoot, then returns to zero.
    const bump = t > 0.6 ? Math.sin(((t - 0.6) / 0.4) * Math.PI) * amount : 0;
    return inOut + bump;
  }

  /** Point on a quadratic Bezier curve. */
  function bezier(
    a: { x: number; y: number },
    control: { x: number; y: number },
    b: { x: number; y: number },
    t: number,
  ): { x: number; y: number } {
    const u = 1 - t;
    return {
      x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
    };
  }

  const api: ReelCursorApi = {
    moveTo(x, y, options = {}) {
      ensureHost();
      const from = { ...current };
      const to = { x, y };
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 1) return Promise.resolve();
      const durationMs =
        options.durationMs ?? Math.min(1400, 420 + distance * 0.75);
      const overshoot = options.overshoot ?? 0.04;
      // Bow the path to one side, like a wrist arc, scaled to the distance.
      const bow = options.straight ? 0 : Math.min(120, distance * 0.18);
      const control = {
        x: from.x + dx / 2 + (-dy / distance) * bow,
        y: from.y + dy / 2 + (dx / distance) * bow,
      };
      return new Promise((resolve) => {
        const began = performance.now();
        /** Advances the pointer one animation frame along the curve. */
        function step(now: number): void {
          const t = Math.min(1, (now - began) / durationMs);
          const eased = easeWithOvershoot(t, overshoot);
          // Past the end, extend along the final direction of travel.
          const point =
            eased <= 1
              ? bezier(from, control, to, eased)
              : {
                  x: to.x + (to.x - control.x) * (eased - 1),
                  y: to.y + (to.y - control.y) * (eased - 1),
                };
          current = point;
          place(point);
          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            current = to;
            place(to);
            resolve();
          }
        }
        requestAnimationFrame(step);
      });
    },
    ripple() {
      track.clicks.push({ epochMs: epochMs(), ...current });
      return Promise.resolve();
    },
    position() {
      return { ...current };
    },
    track() {
      return track;
    },
    carry(element, offset) {
      const overlay = ensureHost();
      element.style.position = "absolute";
      element.style.left = "0";
      element.style.top = "0";
      overlay.insertBefore(element, pointer ?? null);
      const entry = { element, offset };
      carried.push(entry);
      place(current);
      return () => {
        carried.splice(carried.indexOf(entry), 1);
        element.remove();
      };
    },
  };

  (window as unknown as { __reelCursor: ReelCursorApi }).__reelCursor = api;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ensureHost(), {
      once: true,
    });
  } else {
    ensureHost();
  }
}
