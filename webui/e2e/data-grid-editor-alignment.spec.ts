// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

/** Verifies inline edits preserve left, centered, right, and default cell alignment. */
test("grid text editors preserve display alignment through commit and cancel", async ({
  page,
}, testInfo) => {
  await page.route("**/grid-editor-alignment", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><div id="root"></div><script type="module" src="/e2e/fixtures/data-grid-editor-alignment.tsx"></script></body></html>',
    }),
  );
  await page.goto("/grid-editor-alignment");
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();

  for (const [column, alignment] of [
    "left",
    "center",
    "right",
    "right",
  ].entries()) {
    const cell = grid.locator(`#tanstack-cell-${column}-0`);
    await expect(cell.locator("span").last()).toHaveCSS(
      "text-align",
      alignment,
    );
    await cell.dblclick();
    const editor = cell.locator("input");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveCSS("text-align", alignment);
    await editor.fill("Edited text");
    if (column === 0) {
      await grid.screenshot({
        path: testInfo.outputPath("left-aligned-editor.png"),
      });
    }
    await editor.press("Enter");
    await expect(cell).toHaveText("Edited text");
    await expect(cell.locator("span").last()).toHaveCSS(
      "text-align",
      alignment,
    );

    await cell.dblclick();
    await expect(editor).toHaveCSS("text-align", alignment);
    await editor.fill("Cancelled text");
    await editor.press("Escape");
    await expect(cell).toHaveText("Edited text");
  }
});
