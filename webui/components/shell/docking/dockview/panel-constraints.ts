// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi, DockviewGroupPanel } from "dockview";
import { findPanelDefinitionByName } from "../../../../lib/panel-definitions";
import { setEdgeGroupMinimum } from "./edge-group-constraints";

/** Enforces descriptor-owned minimums across group membership and layout restoration. */
export function bindPanelConstraints(api: DockviewApi, gap: number) {
  const tracked = new Map<
    DockviewGroupPanel,
    {
      minWidth: number;
      minHeight: number;
      location: string;
      subscriptions: { dispose(): void }[];
    }
  >();
  let frame: number | undefined;
  let disposed = false;

  /** Defers sizing until Dockview finishes its current layout or membership mutation. */
  function schedule() {
    if (disposed || frame !== undefined) return;
    frame = requestAnimationFrame(reconcile);
  }

  /** Applies the largest member minimum to grid groups and edge splitviews. */
  function reconcile() {
    frame = undefined;
    const groups = new Set(api.groups);
    for (const [group, state] of tracked) {
      if (groups.has(group)) continue;
      for (const subscription of state.subscriptions) subscription.dispose();
      tracked.delete(group);
    }
    for (const group of groups) {
      let state = tracked.get(group);
      if (!state) {
        state = {
          minWidth: 0,
          minHeight: 0,
          location: "",
          subscriptions: [group.api.onDidLocationChange(schedule)],
        };
        tracked.set(group, state);
      }
      const definitions = group.panels.map((panel) =>
        findPanelDefinitionByName(panel.api.component),
      );
      const minWidth = Math.max(
        100,
        ...definitions.map((definition) => definition?.minWidth ?? 100),
      );
      const minHeight = Math.max(
        100,
        ...definitions.map((definition) => definition?.minHeight ?? 100),
      );
      // Dockview subtracts split gutters from allocated view sizes; reserve
      // one gutter so the rendered panel still meets its declared minimum.
      const minimumWidth = minWidth + gap;
      const minimumHeight = minHeight + gap;
      const location = group.api.location;
      const locationKey =
        location.type === "edge" ? `edge:${location.position}` : location.type;
      const changed =
        state.minWidth !== minWidth ||
        state.minHeight !== minHeight ||
        state.location !== locationKey;
      if (changed) {
        state.location = locationKey;
        state.minWidth = minWidth;
        state.minHeight = minHeight;
        group.api.setConstraints({
          minimumWidth,
          minimumHeight,
        });
      }
      if (location.type === "edge" && changed) {
        const horizontal =
          location.position === "left" || location.position === "right";
        setEdgeGroupMinimum(
          api,
          location.position,
          horizontal ? minWidth : minHeight,
        );
      } else if (changed) {
        const width = Math.max(group.api.width, minimumWidth);
        const height = Math.max(group.api.height, minimumHeight);
        if (width !== group.api.width || height !== group.api.height)
          group.api.setSize({ width, height });
      }
    }
  }

  const subscriptions = [
    api.onDidAddGroup(schedule),
    api.onDidRemoveGroup(schedule),
    api.onDidAddPanel(schedule),
    api.onDidRemovePanel(schedule),
    api.onDidMovePanel(schedule),
    api.onDidLayoutFromJSON(schedule),
  ];
  schedule();
  return {
    /** Releases group listeners and pending work before Dockview is disposed. */
    dispose() {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      for (const subscription of subscriptions) subscription.dispose();
      for (const state of tracked.values()) {
        for (const subscription of state.subscriptions) subscription.dispose();
      }
      tracked.clear();
    },
  };
}
