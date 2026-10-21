// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Renders GitHub-style alert blockquotes, such as `> [!WARNING]`, as styled callouts.
 *
 * mdBook 0.4 emits these blocks as plain blockquotes whose first paragraph starts with the
 * marker. This script removes the marker, adds a `callout` class and a type class, and inserts a
 * title, so the guide shows the same callouts GitHub shows when it renders the Markdown source.
 */
(() => {
  const TITLES = {
    NOTE: "Note",
    TIP: "Tip",
    IMPORTANT: "Important",
    WARNING: "Warning",
    CAUTION: "Caution",
  };
  const MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

  for (const quote of document.querySelectorAll("main blockquote")) {
    const first = quote.querySelector(":scope > p");
    const text = first?.firstChild;
    if (!first || text?.nodeType !== Node.TEXT_NODE) continue;
    const match = text.textContent.match(MARKER);
    if (!match) continue;

    const type = match[1];
    text.textContent = text.textContent.slice(match[0].length);
    if (first.textContent.trim() === "") first.remove();

    const title = document.createElement("p");
    title.className = "callout-title";
    title.textContent = TITLES[type];
    quote.prepend(title);
    quote.classList.add("callout", `callout-${type.toLowerCase()}`);
    quote.setAttribute("role", "note");
  }
})();
