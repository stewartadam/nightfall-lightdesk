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

/** Browser-side API the overlay installs on `window.__promoCursor`. */
export interface PromoCursorApi {
  moveTo(x: number, y: number, options?: CursorMoveOptions): Promise<void>;
  ripple(): Promise<void>;
  position(): { x: number; y: number };
  /**
   * Adds an element that rides along with the pointer, drawn just under it in
   * the overlay, such as a file being dragged in. Returns a function that
   * removes it.
   */
  carry(element: HTMLElement, offset: { x: number; y: number }): () => void;
}

/**
 * Installs a fake cursor that glides along curved, eased paths with a slight
 * overshoot and draws a ripple on click. Headless captures never show the
 * system pointer, and real pointer moves teleport, so the recording script
 * animates this overlay first and fires the real input once it arrives.
 *
 * Runs in the page through `page.addInitScript`, so it must stay
 * self-contained: no imports or closures over module scope.
 */
export function installPromoCursor(): void {
  const start = { x: window.innerWidth * 0.62, y: window.innerHeight * 0.78 };
  let current = { ...start };
  let host: HTMLDivElement | undefined;
  let pointer: HTMLDivElement | undefined;
  /** Elements riding along with the pointer, with their offset from its tip. */
  const carried: { element: HTMLElement; offset: { x: number; y: number } }[] =
    [];

  /** Creates the overlay once the document body exists. */
  function ensureHost(): HTMLDivElement {
    if (host?.isConnected) return host;
    host = document.createElement("div");
    host.setAttribute("data-promo-cursor", "true");
    host.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;";
    pointer = document.createElement("div");
    pointer.style.cssText =
      "position:absolute;left:0;top:0;width:30px;height:30px;will-change:transform;filter:drop-shadow(0 3px 6px rgba(0,0,0,.45));";
    pointer.innerHTML =
      '<svg width="30" height="30" viewBox="0 0 24 24" style="display:block;transform-origin:5px 3px"><path d="M4 2.5 L4 19.5 L8.6 15.4 L11.7 22 L14.6 20.7 L11.6 14.3 L17.8 14.3 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
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

  /** Moves the pointer graphic so its tip sits on the given point. */
  function place(point: { x: number; y: number }): void {
    if (!pointer) return;
    // The arrow tip sits 4px right and 2.5px down from the SVG origin at 30/24 scale.
    pointer.style.transform = `translate3d(${point.x - 5}px, ${point.y - 3}px, 0)`;
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

  const api: PromoCursorApi = {
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
      const overlay = ensureHost();
      const ring = document.createElement("div");
      ring.style.cssText = `position:absolute;left:${current.x - 22}px;top:${current.y - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid rgba(255,255,255,.95);background:rgba(120,170,255,.35);box-shadow:0 0 18px rgba(120,170,255,.6);`;
      overlay.insertBefore(ring, pointer ?? null);
      const animation = ring.animate(
        [
          { transform: "scale(.35)", opacity: 1 },
          { transform: "scale(1.5)", opacity: 0 },
        ],
        { duration: 520, easing: "cubic-bezier(.2,.7,.3,1)" },
      );
      // Press the arrow graphic itself, about its tip. Scaling the positioned
      // wrapper would also scale its translate and throw the cursor toward
      // the page origin for the length of the press.
      pointer?.firstElementChild?.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(0.82)", offset: 0.35 },
          { transform: "scale(1)" },
        ],
        { duration: 260, easing: "ease-out" },
      );
      return animation.finished.then(() => ring.remove());
    },
    position() {
      return { ...current };
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

  (window as unknown as { __promoCursor: PromoCursorApi }).__promoCursor = api;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ensureHost(), {
      once: true,
    });
  } else {
    ensureHost();
  }
}
