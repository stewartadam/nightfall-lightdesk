// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi, EdgeGroupPosition } from "dockview";

interface EdgeGroupSizing {
  readonly configuredCollapsedSize: number;
  readonly _gapAdd: number;
  readonly _onDidChange: { fire(event: { size?: number }): void };
  updateSizing(collapsedSize: number, minimumSize: number, gap: number): void;
}

interface DockviewApiWithEdgeSizing {
  component: {
    _shellManager: {
      _viewConfigs: Map<EdgeGroupPosition, { minimumSize?: number }>;
      _getView(position: EdgeGroupPosition): EdgeGroupSizing | undefined;
    };
  };
}

/** Bridges Dockview 8.1's shell-only edge constraints until its public group API supports them. */
export function setEdgeGroupMinimum(
  api: DockviewApi,
  position: EdgeGroupPosition,
  minimumSize: number,
) {
  const shell = (api as unknown as DockviewApiWithEdgeSizing).component
    ._shellManager;
  const view = shell._getView(position);
  const config = shell._viewConfigs.get(position);
  if (!view || !config)
    throw new Error(`Missing Dockview edge sizing for ${position}`);
  config.minimumSize = minimumSize;
  view.updateSizing(view.configuredCollapsedSize, minimumSize, view._gapAdd);
  // Notify the owning splitview so pointer resizing, expansion, and restored
  // sizes all use the same constraint without changing collapsed rail geometry.
  view._onDidChange.fire({});
}
