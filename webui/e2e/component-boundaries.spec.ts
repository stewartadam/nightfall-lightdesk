// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

/** Verifies production component boundary attributes are present for panels and shared markup. */
test("registered panels and shared components expose production boundaries", async ({
  page,
}) => {
  await page.goto(
    "/?e2e=1&scenario=component-boundaries&startup:draftRecovery=false",
  );
  await expect(page.locator("main#app")).toBeVisible();

  const panelBoundary = page
    .locator("[data-panel-kind][data-panel-id][data-component]:visible")
    .first();
  await expect(panelBoundary).toBeVisible();
  await expect(panelBoundary).toHaveAttribute("data-panel-kind", /.+/);
  await expect(panelBoundary).toHaveAttribute("data-panel-id", /.+/);
  await expect(panelBoundary).toHaveAttribute("data-component", /.+/);

  await expect(page.locator('svg[aria-hidden="true"]').first()).toBeVisible();
});
