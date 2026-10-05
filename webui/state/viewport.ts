// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";

/**
 * Viewports too small for a docked multi-panel workspace: narrow screens such as
 * a phone in portrait, and short touch screens such as a phone in landscape.
 */
export const COMPACT_VIEWPORT_QUERY =
  "(max-width: 639px), (pointer: coarse) and (max-height: 500px)";

const media =
  typeof window === "undefined"
    ? undefined
    : window.matchMedia(COMPACT_VIEWPORT_QUERY);

/** Whether the shell presents one panel at a time instead of the docked workspace. */
export const compactViewport = atom(media?.matches ?? false);

/** Follows rotation and window resizes across the compact breakpoint. */
function updateCompactViewport(event: MediaQueryListEvent): void {
  compactViewport.set(event.matches);
}
media?.addEventListener("change", updateCompactViewport);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    media?.removeEventListener("change", updateCompactViewport);
  });
}
