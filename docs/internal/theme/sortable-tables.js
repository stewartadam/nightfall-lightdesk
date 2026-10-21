// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Makes every table on the page sortable by clicking a column heading.
 *
 * Each heading becomes a button. The first click sorts the rows by that column in ascending
 * order, the next click reverses it, and the heading's `aria-sort` attribute reports the state
 * to assistive technology. Text compares in natural order, so `ch 2` sorts before `ch 10`.
 * Tables with fewer than three rows stay as they are, since sorting them adds nothing.
 */
(() => {
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });

  /** Sorts a table's body rows by one column and updates every heading's sort state. */
  const sortTable = (table, headings, column, direction) => {
    const body = table.tBodies[0];
    const rows = Array.from(body.rows);
    const sign = direction === "ascending" ? 1 : -1;
    rows.sort(
      (left, right) =>
        sign *
        collator.compare(
          left.cells[column]?.textContent.trim() ?? "",
          right.cells[column]?.textContent.trim() ?? "",
        ),
    );
    body.append(...rows);
    headings.forEach((heading, index) => {
      if (index === column) heading.setAttribute("aria-sort", direction);
      else heading.removeAttribute("aria-sort");
    });
  };

  for (const table of document.querySelectorAll("main table")) {
    const headings = Array.from(table.tHead?.rows[0]?.cells ?? []);
    if (headings.length === 0 || (table.tBodies[0]?.rows.length ?? 0) < 3) {
      continue;
    }
    table.classList.add("sortable");
    headings.forEach((heading, column) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sort-button";
      button.append(...heading.childNodes);
      heading.append(button);
      button.addEventListener("click", () => {
        const next =
          heading.getAttribute("aria-sort") === "ascending"
            ? "descending"
            : "ascending";
        sortTable(table, headings, column, next);
      });
    });
  }
})();
