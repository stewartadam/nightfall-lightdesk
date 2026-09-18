// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { focusTrackedComponent } from "../../../lib/keyboardShortcuts";

/** Finds the Dockview render overlay that owns a timeline toolbar control. */
function findPanelRenderOverlay(
  control: HTMLElement,
  componentId: string,
): HTMLElement | undefined {
  const panelRoot = control.closest<HTMLElement>("[data-panel-id]");
  if (panelRoot?.dataset.panelId !== componentId) return undefined;
  let current: HTMLElement | null = panelRoot;
  while (current) {
    if (current.classList.contains("dv-render-overlay")) return current;
    const overlay = current.querySelector<HTMLElement>(".dv-render-overlay");
    if (overlay) return overlay;
    current = current.parentElement;
  }
  return undefined;
}

/** Returns keyboard focus to the timeline panel after native toolbar controls change. */
export function refocusTimelinePanel(
  control: HTMLElement,
  componentId: string,
) {
  focusTrackedComponent(componentId);
  requestAnimationFrame(() => {
    const overlay = findPanelRenderOverlay(control, componentId);
    if (!overlay) return;
    if (!overlay.hasAttribute("tabindex")) {
      overlay.tabIndex = -1;
    }
    overlay.focus({
      preventScroll: true,
    });
  });
}
