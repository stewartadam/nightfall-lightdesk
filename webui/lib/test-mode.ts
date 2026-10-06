// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Whether this bundle came from `vite build --mode e2e`, the production build
 * native Playwright runs serve. Such builds expose test hooks unconditionally,
 * bundle the browser-side e2e harnesses and reach the backend through the
 * page's own origin.
 */
export const isE2eBuild = import.meta.env?.MODE === "e2e";

/**
 * Returns whether the page exposes `window.__nightfallTest` and
 * `window.appStores`: always in dev servers and e2e builds, and in any other
 * build only when the URL carries `e2e=1` (browser-demo artifact tests).
 */
export function testHooksEnabled(): boolean {
  if (import.meta.env?.DEV || isE2eBuild) return true;
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("e2e") === "1"
  );
}
