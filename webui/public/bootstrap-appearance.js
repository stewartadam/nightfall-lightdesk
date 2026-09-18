// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Applies the saved motion preference before the bootstrap splash can paint. */
(() => {
  let preference = "auto";
  try {
    const saved = JSON.parse(
      localStorage.getItem("nightfall-appearance") || "null",
    );
    if (saved?.reducedMotion === "on" || saved?.reducedMotion === "off") {
      preference = saved.reducedMotion;
    }
  } catch {
    // Unavailable or malformed storage falls back to the system preference.
  }
  document.documentElement.dataset.reducedMotion = String(
    preference === "on" ||
      (preference === "auto" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches),
  );
})();
