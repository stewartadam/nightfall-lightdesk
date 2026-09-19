// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Adds the Nightfall homepage beside mdBook's built-in repository link. */
(() => {
  const buttons = document.querySelector(".menu-bar .right-buttons");
  if (!buttons) return;

  const home = document.createElement("a");
  home.href = "https://nightfall.live";
  home.title = "Nightfall homepage";
  home.setAttribute("aria-label", "Nightfall homepage");

  const icon = document.createElement("i");
  icon.className = "fa fa-home";
  icon.setAttribute("aria-hidden", "true");
  home.append(icon);
  buttons.prepend(home);
})();
