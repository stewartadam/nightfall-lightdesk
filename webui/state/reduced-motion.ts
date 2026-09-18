// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom, computed } from "nanostores";
import { appearanceSettings } from "./appearance";

const media =
  typeof window === "undefined"
    ? undefined
    : window.matchMedia("(prefers-reduced-motion: reduce)");
const systemReducedMotion = atom(media?.matches ?? false);

/** Resolves the local override against the live OS/browser motion preference. */
export const reducedMotion = computed(
  [appearanceSettings, systemReducedMotion],
  (appearance, system) =>
    appearance.reducedMotion === "auto"
      ? system
      : appearance.reducedMotion === "on",
);

/** Updates Auto mode when the OS/browser preference changes. */
function updateSystemPreference(event: MediaQueryListEvent): void {
  systemReducedMotion.set(event.matches);
}
media?.addEventListener("change", updateSystemPreference);

/** Keeps CSS and JavaScript animations on the same effective motion preference. */
const unsubscribe = reducedMotion.subscribe((reduce) => {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.reducedMotion = String(reduce);
  }
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe();
    media?.removeEventListener("change", updateSystemPreference);
  });
}
