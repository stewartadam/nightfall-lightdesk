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

/** Dockview's own floor for the shell's grid column, kept for an empty grid. */
const DOCKVIEW_SHELL_MINIMUM = 100;

interface ShellSplitview {
  readonly size: number;
  readonly margin: number;
  readonly viewItems: readonly {
    view: unknown;
    visible: boolean;
    minimumSize: number;
  }[];
  getViews(): ShellViewSizing[];
}

interface ShellViewSizing {
  minimumSize: number;
  readonly _onDidChange: { fire(event: { size?: number }): void };
}

interface MiddleColumnSizing extends ShellViewSizing {
  readonly _centerIndex: number;
  readonly _splitview: ShellSplitview;
}

interface DockviewApiWithEdgeSizing {
  component: {
    readonly minimumWidth: number;
    readonly minimumHeight: number;
    _shellManager: {
      _middleColumn: MiddleColumnSizing;
      _outerSplitview: ShellSplitview;
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

/**
 * Holds the shell's grid column to the grid's own minimum size until disposed.
 *
 * Dockview 8.x gives the shell column around the grid a fixed 100px minimum,
 * so a wide edge group could squeeze the grid below its panels' minimums: the
 * grid then kept its minimum size and slid underneath the edge group while only
 * the top/bottom edge groups reflowed. Mirroring the grid minimum makes edge
 * resizing shrink the grid panels first and stop once they reach their minimums.
 */
export function bindGridMinimum(api: DockviewApi) {
  const component = (api as unknown as DockviewApiWithEdgeSizing).component;
  const shell = component._shellManager;
  const middle = shell._middleColumn;
  const center = middle._splitview.getViews()[middle._centerIndex];
  if (!center) throw new Error("Missing Dockview shell center view");
  defineGridMinimum(
    shell._outerSplitview,
    middle,
    () => component.minimumWidth,
  );
  defineGridMinimum(middle._splitview, center, () => component.minimumHeight);
  return {
    /** Lets both shell splitviews re-clamp their views after the grid minimum changes. */
    reclamp() {
      center._onDidChange.fire({});
      middle._onDidChange.fire({});
    },
    /** Restores Dockview's fixed minimum before the bridge is released. */
    dispose() {
      for (const view of [middle, center]) {
        delete (view as Partial<ShellViewSizing>).minimumSize;
        view.minimumSize = DOCKVIEW_SHELL_MINIMUM;
      }
    },
  };
}

/**
 * Replaces a shell view's fixed minimum with the grid's live minimum. When the
 * window cannot fit the grid beside its edge groups' minimums, the grid gives
 * up the difference and clips, so the edge groups stay on screen.
 */
function defineGridMinimum(
  splitview: ShellSplitview,
  view: ShellViewSizing,
  gridMinimum: () => number,
) {
  Object.defineProperty(view, "minimumSize", {
    configurable: true,
    get() {
      let reserved = 0;
      let visible = 0;
      for (const item of splitview.viewItems) {
        if (item.visible) visible += 1;
        if (item.view !== view) reserved += item.minimumSize;
      }
      // Splitviews take their gutters out of every visible view's size.
      const gutter = (splitview.margin * Math.max(0, visible - 1)) / visible;
      const available = splitview.size - reserved;
      return Math.max(
        DOCKVIEW_SHELL_MINIMUM,
        Math.min(gridMinimum() + gutter, available),
      );
    },
  });
}
