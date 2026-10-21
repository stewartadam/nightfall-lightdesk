// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Marks the sidebar link for the current page as active when the host serves pages without
 * their `.html` extension.
 *
 * mdBook's sidebar compares each link's full URL to the page URL. Hosts such as Cloudflare
 * Workers static assets redirect `page.html` to `page` and `index.html` to the folder, so that
 * comparison never matches and no link is highlighted. This script compares the paths with the
 * extension and a trailing `index` removed, and adds the `active` class mdBook would have set.
 */
(() => {
  /** Returns a URL's origin and path without a trailing `.html` or `index`. */
  const normalize = (href) => {
    const url = new URL(href, document.baseURI);
    const path = url.pathname
      .replace(/\/index(\.html)?$/, "/")
      .replace(/\.html$/, "");
    return url.origin + path;
  };

  const sidebar = document.querySelector("#sidebar");
  if (!sidebar || sidebar.querySelector("a.active")) return;

  const current = normalize(document.location.href);
  const link = Array.from(sidebar.querySelectorAll(".chapter a[href]")).find(
    (candidate) => normalize(candidate.href) === current,
  );
  if (!link) return;

  link.classList.add("active");
  for (
    let item = link.closest("li");
    item;
    item = item.parentElement?.closest("li")
  ) {
    if (item.classList.contains("chapter-item")) item.classList.add("expanded");
  }
})();
