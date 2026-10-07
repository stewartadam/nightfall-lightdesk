// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  DockviewApi,
  DockviewGroupPanel,
  EdgeGroupPosition,
  IDockviewPanel,
} from "dockview";

/** Edge panels follow the grid in this order, so Clips sits beside the main panels. */
const EDGE_ORDER: readonly EdgeGroupPosition[] = [
  "left",
  "right",
  "bottom",
  "top",
];

/** Ranks a group so the flattened tab order follows the docked layout's reading order. */
function groupRank(group: DockviewGroupPanel): number {
  const location = group.api.location;
  if (location.type === "grid") return 0;
  if (location.type === "edge")
    return 1 + EDGE_ORDER.indexOf(location.position);
  return 1 + EDGE_ORDER.length;
}

/** Lists panels in grid order, then edge groups, then floating and popout groups. */
export function compactPanelOrder(api: DockviewApi): IDockviewPanel[] {
  return [...api.groups]
    .map((group, index) => ({ group, index }))
    .sort(
      (a, b) => groupRank(a.group) - groupRank(b.group) || a.index - b.index,
    )
    .flatMap(({ group }) => group.panels);
}

/**
 * Keeps every panel of a compact workspace in one grid group with its tab
 * header hidden, so the shell's own navigation shows one panel at a time.
 * Restored layouts, edge groups and panels opened by features into new groups
 * are folded into that group as they appear. The compact workspace is never
 * persisted, so this never alters a saved or docked layout.
 */
export function bindCompactPresentation(api: DockviewApi) {
  let queued = false;
  let disposed = false;

  /** Coalesces Dockview mutations into one fold after the current operation completes. */
  function schedule() {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(reconcile);
  }

  /** Moves stray panels into the main group, removes emptied edges and hides the tab strip. */
  function reconcile() {
    queued = false;
    if (disposed || api.panels.length === 0) return;
    const ordered = compactPanelOrder(api);
    const active = api.activePanel;
    let target = api.groups.find((group) => group.api.location.type === "grid");
    if (!target) target = api.addGroup();
    for (const panel of ordered) {
      if (panel.group === target) continue;
      panel.api.moveTo({
        group: target,
        position: "center",
        skipSetActive: true,
      });
    }
    for (const position of EDGE_ORDER) {
      if (api.getEdgeGroup(position)) api.removeEdgeGroup(position);
    }
    for (const group of api.groups) {
      if (group !== target && group.panels.length === 0) api.removeGroup(group);
    }
    target.header.hidden = true;
    const next = active && api.getPanel(active.id);
    if (next && api.activePanel !== next) next.api.setActive();
  }

  const subscriptions = [
    api.onDidAddPanel(schedule),
    api.onDidMovePanel(schedule),
    api.onDidAddGroup(schedule),
    api.onDidLayoutFromJSON(schedule),
  ];
  schedule();
  return {
    /** Stops folding before the owning Dockview is disposed. */
    dispose() {
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
