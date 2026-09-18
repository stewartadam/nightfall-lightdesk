// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, onCleanup } from "solid-js";

let activeLockCount = 0;
let previousBodyOverflow = "";

/** Locks document body scrolling while modal or overlay UI is visible. */
export function createModalScrollLock(isOpen: () => boolean): void {
  createEffect(() => {
    if (!isOpen()) return;
    if (typeof document === "undefined") return;

    if (activeLockCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    activeLockCount += 1;

    onCleanup(() => {
      activeLockCount = Math.max(0, activeLockCount - 1);
      if (activeLockCount === 0) {
        document.body.style.overflow = previousBodyOverflow;
        previousBodyOverflow = "";
      }
    });
  });
}
