// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { DockviewCompositeDisposable, type DockviewPanelApi } from "dockview";

/** Keeps detached panel content styled for its active state and current viewport edge. */
export function bindPanelAppearance(
  element: HTMLElement,
  api: DockviewPanelApi,
) {
  element.dataset.panelActive = String(api.isActive);
  /** Carries the edge location to content that cannot inherit the group shell's clipping. */
  const updateEdge = () => {
    const location = api.location;
    if (location.type === "edge") {
      element.dataset.panelEdge = location.position;
    } else {
      delete element.dataset.panelEdge;
    }
  };
  updateEdge();
  return new DockviewCompositeDisposable(
    api.onDidActiveChange(({ isActive }) => {
      element.dataset.panelActive = String(isActive);
    }),
    api.onDidLocationChange(updateEdge),
  );
}
