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

  // mdBook 0.5 draws toolbar icons as inline Font Awesome SVGs, so the home icon does too.
  const SVG = "http://www.w3.org/2000/svg";
  const icon = document.createElement("span");
  icon.className = "fa-svg";
  icon.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 576 512");
  const path = document.createElementNS(SVG, "path");
  // Font Awesome Free 6.2.0 "house" (CC BY 4.0), the same icon set mdBook bundles.
  path.setAttribute(
    "d",
    "M575.8 255.5c0 18-15 32.1-32 32.1h-32l.7 160.2c0 2.7-.2 5.4-.5 8.1V472c0 22.1-17.9 40-40 40H456c-1.1 0-2.2 0-3.3-.1c-1.4 .1-2.8 .1-4.2 .1H416 392c-22.1 0-40-17.9-40-40V448 384c0-17.7-14.3-32-32-32H256c-17.7 0-32 14.3-32 32v64 24c0 22.1-17.9 40-40 40H160 128.1c-1.5 0-3-.1-4.5-.2c-1.2 .1-2.4 .2-3.6 .2H104c-22.1 0-40-17.9-40-40V360c0-.9 0-1.9 .1-2.8V287.6H32c-18 0-32-14-32-32.1c0-9 3-17 10-24L266.4 8c7-7 15-8 22-8s15 2 21 7L564.8 231.5c8 7 12 15 11 24z",
  );
  svg.append(path);
  icon.append(svg);
  home.append(icon);
  buttons.prepend(home);
})();
