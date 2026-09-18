// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type ContentEntrance =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "fade"
  | "zoom";

export interface ContentEntranceOptions {
  direction: ContentEntrance;
  duration?: number;
  delay?: number;
  easing?: string;
  distance?: number;
  opacity?: number;
  scale?: number;
  onComplete?: () => void;
}

const directions: Record<ContentEntrance, string> = {
  left: "slide-in-from-left",
  right: "slide-in-from-right",
  top: "slide-in-from-top",
  bottom: "slide-in-from-bottom",
  fade: "",
  zoom: "zoom-in",
};
const activeEntrances = new WeakMap<HTMLElement, () => void>();

/** Replays tw-animate-css entrances while preserving existing styles and cancelling superseded runs. */
export function playContentEntrance(
  element: HTMLElement,
  options: ContentEntranceOptions,
): () => void {
  activeEntrances.get(element)?.();
  const root = element.ownerDocument.documentElement;
  const reduced = root.dataset.reducedMotion;
  if (
    reduced === "true" ||
    (reduced !== "false" &&
      element.ownerDocument.defaultView?.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches)
  ) {
    options.onComplete?.();
    return () => {};
  }
  const distance = options.distance ?? 100;
  const properties: Record<string, string> = {
    "--tw-animation-duration": `${options.duration ?? 250}ms`,
    "--tw-animation-delay": `${options.delay ?? 0}ms`,
    "--tw-animation-fill-mode": "both",
    "--tw-ease": options.easing ?? "cubic-bezier(0.22, 1, 0.36, 1)",
    "--tw-enter-opacity": String(options.opacity ?? 0),
    "--tw-enter-translate-x": `${options.direction === "left" ? -distance : options.direction === "right" ? distance : 0}%`,
    "--tw-enter-translate-y": `${options.direction === "top" ? -distance : options.direction === "bottom" ? distance : 0}%`,
    "--tw-enter-scale": String(
      options.direction === "zoom" ? (options.scale ?? 0.8) : 1,
    ),
  };
  const previous = Object.keys(properties).map((name) => [
    name,
    element.style.getPropertyValue(name),
    element.style.getPropertyPriority(name),
  ]);
  const classes = [
    "animate-in",
    "fade-in",
    "motion-reduce:animate-none",
    directions[options.direction],
  ].filter((name) => name && !element.classList.contains(name));
  let cleaned = false;
  /** Removes only this entrance's classes, inline overrides, and event listeners. */
  function cancel() {
    if (cleaned) return;
    cleaned = true;
    element.removeEventListener("animationend", finish);
    element.classList.remove(...classes);
    for (const [name, value, priority] of previous) {
      if (value) element.style.setProperty(name, value, priority);
      else element.style.removeProperty(name);
    }
    activeEntrances.delete(element);
  }
  /** Completes only the entrance on this element, ignoring animations bubbling from descendants. */
  function finish(event: AnimationEvent) {
    if (event.target !== element || event.animationName !== "enter") return;
    cancel();
    options.onComplete?.();
  }
  // Flush removal of the previous entrance so repeated directions restart without remounting content.
  void element.offsetWidth;
  for (const [name, value] of Object.entries(properties))
    element.style.setProperty(name, value);
  element.addEventListener("animationend", finish);
  element.classList.add(...classes);
  activeEntrances.set(element, cancel);
  return cancel;
}
