// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";

/**
 * Activates and focuses a docked panel the way the app's open commands do, expanding its edge
 * group first because Dockview hides panels inside a collapsed edge.
 */
export async function revealPanel(page: Page, panelId: string): Promise<void> {
  await page.evaluate((id) => {
    const panel = (window as any).appStores.dockApi.get().getPanel(id);
    panel?.api.setActive();
    if (panel?.group.api.location.type === "edge") panel.group.api.expand();
    panel?.focus();
  }, panelId);
}
