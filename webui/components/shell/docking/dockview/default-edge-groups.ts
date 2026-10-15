// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type DockviewApi,
  type DockviewGroupPanel,
  type EdgeGroupPosition,
  getPanelData,
  type PanelTransfer,
} from "dockview";

/** Size of a collapsed structural edge group rail. */
export const EDGE_GROUP_COLLAPSED_SIZE = 34;

export const DEFAULT_EDGE_GROUP_POSITIONS = [
  "left",
  "bottom",
  "right",
] as const satisfies readonly EdgeGroupPosition[];

export type DefaultEdgeGroupPosition =
  (typeof DEFAULT_EDGE_GROUP_POSITIONS)[number];

/** Dockview group IDs of the structural edge slots seeded by the default layout. */
export const DEFAULT_EDGE_GROUP_IDS: Record<DefaultEdgeGroupPosition, string> =
  {
    bottom: "edge-Console",
    left: "edge-Clips",
    right: "edge-Properties",
  };

/** Returns whether a Dockview drop position belongs to a default edge group. */
export function isDefaultEdgeGroupPosition(
  position: string,
): position is DefaultEdgeGroupPosition {
  return (DEFAULT_EDGE_GROUP_POSITIONS as readonly string[]).includes(position);
}

/** Returns the Dockview group backing one of the default edge slots. */
export function getDefaultEdgeGroup(
  api: DockviewApi,
  position: DefaultEdgeGroupPosition,
): DockviewGroupPanel | undefined {
  return api.groups.find(
    (group) => group.id === DEFAULT_EDGE_GROUP_IDS[position],
  );
}

/** Hides default edge groups that currently have no panels. */
export function hideEmptyDefaultEdgeGroups(api: DockviewApi): void {
  for (const edgePosition of DEFAULT_EDGE_GROUP_POSITIONS) {
    const group = getDefaultEdgeGroup(api, edgePosition);
    if (group && group.panels.length === 0) {
      api.setEdgeGroupVisible(edgePosition, false);
    }
  }
}

/** Returns whether the app should expose a custom drop target for an edge. */
function isHiddenDefaultEdgeDropTarget(
  api: DockviewApi,
  position: DefaultEdgeGroupPosition,
  sourcePosition?: DefaultEdgeGroupPosition,
): boolean {
  if (position === sourcePosition) return false;

  const group = getDefaultEdgeGroup(api, position);
  return Boolean(
    group && group.panels.length === 0 && !api.isEdgeGroupVisible(position),
  );
}

/** Returns hidden, empty default edge groups that can receive custom drops. */
export function getHiddenDefaultEdgeDropTargets(
  api: DockviewApi,
  sourcePosition?: DefaultEdgeGroupPosition,
): DefaultEdgeGroupPosition[] {
  return DEFAULT_EDGE_GROUP_POSITIONS.filter((position) =>
    isHiddenDefaultEdgeDropTarget(api, position, sourcePosition),
  );
}

/** Returns whether a Dockview transfer can be routed to a default edge group. */
export function canMovePanelTransferToDefaultEdgeGroup(
  api: DockviewApi,
  position: DefaultEdgeGroupPosition,
  data: PanelTransfer | undefined = getPanelData(),
): boolean {
  if (!data || data.viewId !== api.id) return false;

  const targetGroup = getDefaultEdgeGroup(api, position);
  const sourceGroup = api.groups.find((group) => group.id === data.groupId);
  return Boolean(
    targetGroup && sourceGroup && sourceGroup.id !== targetGroup.id,
  );
}

/**
 * Moves a Dockview drag transfer (a panel, a tab group, or a whole group) into
 * one of the default edge groups, revealing and expanding the target edge and
 * hiding any default edge the move leaves empty. Returns whether it moved.
 */
export function movePanelTransferToDefaultEdgeGroup(
  api: DockviewApi,
  position: DefaultEdgeGroupPosition,
  data: PanelTransfer | undefined = getPanelData(),
): boolean {
  if (!data) return false;
  if (!canMovePanelTransferToDefaultEdgeGroup(api, position, data)) {
    return false;
  }
  const targetGroup = getDefaultEdgeGroup(api, position);
  const sourceGroup = api.groups.find((group) => group.id === data.groupId);
  if (!targetGroup || !sourceGroup) return false;

  api.setEdgeGroupVisible(position, true);
  api.getEdgeGroup(position)?.expand();

  if (data.panelId !== null) {
    api.getPanel(data.panelId)?.api.moveTo({
      group: targetGroup,
      position: "center",
    });
    hideEmptyDefaultEdgeGroups(api);
    return true;
  }

  if (data.tabGroupId) {
    const sourceTabGroup = api
      .getTabGroups({ groupId: data.groupId })
      .find((tabGroup) => tabGroup.id === data.tabGroupId);
    if (!sourceTabGroup) return false;

    const panelIds = [...sourceTabGroup.panelIds];
    for (const panelId of panelIds) {
      api.getPanel(panelId)?.api.moveTo({
        group: targetGroup,
        position: "center",
      });
    }

    if (panelIds.length > 1) {
      const targetTabGroup = api.createTabGroup({
        color: sourceTabGroup.color,
        componentParams: sourceTabGroup.componentParams,
        groupId: targetGroup.id,
        label: sourceTabGroup.label,
      });

      for (const panelId of panelIds) {
        api.addPanelToTabGroup({
          groupId: targetGroup.id,
          panelId,
          tabGroupId: targetTabGroup.id,
        });
      }

      if (sourceTabGroup.collapsed) {
        targetTabGroup.collapse();
      }
    }

    hideEmptyDefaultEdgeGroups(api);
    return true;
  }

  sourceGroup.api.moveTo({
    group: targetGroup,
    position: "center",
  });
  hideEmptyDefaultEdgeGroups(api);
  return true;
}
