// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import "./layout-entrance.css";

/** Creates a compositor-friendly entrance using shared slide and timing utilities. */
export function createLayoutEntrance(element: HTMLElement, direction: number) {
  const classes = [
    "animate-in",
    "[animation-name:nf-layout-enter]",
    "duration-[220ms]",
    "ease-[cubic-bezier(0.2,0,0.2,1)]",
    "fill-mode-backwards",
    ...(direction === 0
      ? []
      : [direction < 0 ? "slide-in-from-left-8" : "slide-in-from-right-8"]),
  ];
  element.classList.add(...classes);
  /** Removes the entrance classes before the workspace is recalled again. */
  const dispose = () => {
    element.classList.remove(...classes);
    // Flush removal so an immediate recall starts a new CSS animation.
    element.getAnimations();
  };
  const animation = element
    .getAnimations()
    .find(
      (candidate) =>
        candidate instanceof CSSAnimation &&
        candidate.animationName === "nf-layout-enter",
    );
  if (!animation) {
    dispose();
    return undefined;
  }
  return { animation, dispose };
}
