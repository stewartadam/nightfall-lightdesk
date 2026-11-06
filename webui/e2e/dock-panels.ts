// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";

/**
 * Activates and focuses a docked panel the way the app's open commands do: a hidden edge group is
 * shown and a collapsed one expanded first, because Dockview hides panels inside a collapsed edge.
 */
export async function revealPanel(page: Page, panelId: string): Promise<void> {
  await page.evaluate((id) => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.getPanel(id);
    const location = panel?.group.api.location;
    if (location?.type === "edge") {
      if (!api.isEdgeGroupVisible(location.position)) {
        api.setEdgeGroupVisible(location.position, true);
      }
      panel.group.api.expand();
    }
    panel?.api.setActive();
    panel?.focus();
  }, panelId);
}
