// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { dockApi } from "../../../state/appStores";

/** Dockview ID of the Properties panel. */
const PROPERTIES_PANEL_ID = "panel-PropertiesInspector";

/**
 * Brings the Properties panel into view for the panel `sourcePanelId`, opening it when the
 * layout has none.
 *
 * Properties docked in a collapsed edge group is expanded, and focus goes back to the source
 * panel afterwards so its provider stays the one Properties shows. Properties docked in the
 * grid is focused.
 */
export function revealPropertiesPanel(sourcePanelId: string): void {
  const api = dockApi.get();
  if (!api) return;

  const propertiesPanel = api.getPanel(PROPERTIES_PANEL_ID);
  if (!propertiesPanel) {
    api.addPanel({
      id: PROPERTIES_PANEL_ID,
      component: "PropertiesInspector",
      title: "Properties",
      params: {},
    });
    return;
  }
  const location = propertiesPanel.api.location;
  if (location.type === "edge") {
    propertiesPanel.api.setActive();
    api.getEdgeGroup(location.position)?.expand();
    requestAnimationFrame(() => api.getPanel(sourcePanelId)?.api.setActive());
  } else {
    propertiesPanel.focus();
  }
}
