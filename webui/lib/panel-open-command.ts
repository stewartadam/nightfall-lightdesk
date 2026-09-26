// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewGroupLocation, EdgeGroupPosition } from "dockview";
import {
  findPanelDefinitionByName,
  type PanelDefinition,
} from "./panel-definitions";

export type PanelOpenPlacement =
  | "default"
  | "group-left"
  | "group-right"
  | "row-above"
  | "row-below"
  | "split-top"
  | "split-bottom"
  | "split-left"
  | "split-right";

type PanelOpenDirection = "left" | "right" | "above" | "below";

interface FocusableGroupApi {
  setSize: (size: { height?: number; width?: number }) => void;
}

interface FocusablePanelApi {
  readonly location?: DockviewGroupLocation;
}

interface FocusableGroup {
  readonly id: string;
  readonly api?: FocusableGroupApi;
  readonly height?: number;
  readonly width?: number;
}

interface FocusablePanel {
  readonly id: string;
  readonly api?: FocusablePanelApi;
  readonly group?: FocusableGroup;
  focus: () => void;
}

interface ExpandableEdgeGroup {
  expand: () => void;
}

type PanelPosition =
  | {
      direction: PanelOpenDirection;
      referenceGroup: string;
    }
  | {
      direction: PanelOpenDirection;
    };

interface AddPanelParams {
  id: string;
  component: string;
  title: string;
  params: Record<string, never>;
  initialHeight?: number;
  initialWidth?: number;
  position?: PanelPosition;
}

export interface PanelOpenDockApi {
  readonly activeGroup?: FocusableGroup;
  readonly activePanel?: FocusablePanel;
  getPanel: (id: string) => FocusablePanel | undefined;
  getEdgeGroup?: (
    position: EdgeGroupPosition,
  ) => ExpandableEdgeGroup | undefined;
  setEdgeGroupVisible?: (position: EdgeGroupPosition, visible: boolean) => void;
  addPanel: (params: AddPanelParams) => unknown;
}

export interface PanelOpenModifierState {
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

export interface PanelOpenExecutionContext {
  readonly source?: string;
  readonly event?: PanelOpenModifierState;
}

/** Returns the palette placement requested by a modifier-key activation. */
export function panelOpenPlacementFromModifiers(
  modifiers: PanelOpenModifierState | undefined,
): PanelOpenPlacement {
  if (!modifiers) {
    return "default";
  }

  if (modifiers.metaKey && modifiers.altKey) {
    return modifiers.shiftKey ? "split-left" : "split-right";
  }

  if (modifiers.altKey) {
    return modifiers.shiftKey ? "split-top" : "split-bottom";
  }

  if (modifiers.metaKey) {
    return modifiers.shiftKey ? "row-above" : "row-below";
  }

  if (modifiers.ctrlKey) {
    return modifiers.shiftKey ? "group-right" : "group-left";
  }

  return "default";
}

/** Returns short user-facing text for a modifier-requested panel placement. */
export function panelOpenPlacementLabel(
  placement: PanelOpenPlacement,
): string | undefined {
  switch (placement) {
    case "group-left":
      return "new group right";
    case "group-right":
      return "new group right";
    case "row-above":
      return "new row above";
    case "row-below":
      return "new row below";
    case "split-top":
      return "split above";
    case "split-bottom":
      return "split below";
    case "split-left":
      return "split left";
    case "split-right":
      return "split right";
    case "default":
      return undefined;
  }
}

/** Restricts modifier-based panel placement to command palette activation. */
export function panelOpenPlacementFromExecutionContext(
  context: PanelOpenExecutionContext | undefined,
): PanelOpenPlacement {
  if (context?.source !== "palette") {
    return "default";
  }

  return panelOpenPlacementFromModifiers(context.event);
}

/** Returns the keyboard shortcut that opens a singleton panel directly. */
export function getPanelOpenShortcut(
  componentName: string,
): string | undefined {
  return findPanelDefinitionByName(componentName)?.shortcut;
}

/** Returns the active Dockview group, preferring the API active group. */
function activeGroupForApi(api: PanelOpenDockApi): FocusableGroup | undefined {
  return api.activeGroup ?? api.activePanel?.group;
}

/** Returns whether placement splits the active Dockview group itself. */
function isCurrentGroupSplitPlacement(placement: PanelOpenPlacement): boolean {
  return (
    placement === "split-left" ||
    placement === "split-right" ||
    placement === "split-top" ||
    placement === "split-bottom"
  );
}

/** Returns the Dockview direction for a placement with no reference group. */
function currentGroupSplitDirectionForPlacement(
  placement: PanelOpenPlacement,
): PanelOpenDirection | undefined {
  switch (placement) {
    case "split-left":
      return "left";
    case "split-right":
      return "right";
    case "split-top":
      return "above";
    case "split-bottom":
      return "below";
    case "default":
    case "group-left":
    case "group-right":
    case "row-above":
    case "row-below":
      return undefined;
  }
}

/** Returns the Dockview direction for a root-level row placement. */
function rootRowDirectionForPlacement(
  placement: PanelOpenPlacement,
): PanelOpenDirection | undefined {
  switch (placement) {
    case "row-above":
      return "above";
    case "row-below":
      return "below";
    case "default":
    case "group-left":
    case "group-right":
    case "split-left":
    case "split-right":
    case "split-top":
    case "split-bottom":
      return undefined;
  }
}

/** Returns the Dockview direction for placement around the active group. */
function referencedGroupDirectionForPlacement(
  placement: PanelOpenPlacement,
): PanelOpenDirection | undefined {
  switch (placement) {
    case "group-left":
      return "right";
    case "group-right":
      return "left";
    case "default":
    case "row-above":
    case "row-below":
    case "split-left":
    case "split-right":
    case "split-top":
    case "split-bottom":
      return undefined;
  }
}

/** Builds Dockview positioning options for the requested panel placement. */
function panelPositionForPlacement(
  api: PanelOpenDockApi,
  placement: PanelOpenPlacement,
  activeGroup = activeGroupForApi(api),
): PanelPosition | undefined {
  const currentGroupSplitDirection =
    currentGroupSplitDirectionForPlacement(placement);
  if (currentGroupSplitDirection) {
    if (activeGroup) {
      return {
        direction: currentGroupSplitDirection,
        referenceGroup: activeGroup.id,
      };
    }

    return { direction: currentGroupSplitDirection };
  }

  const rootRowDirection = rootRowDirectionForPlacement(placement);
  if (rootRowDirection) {
    return { direction: rootRowDirection };
  }

  const referencedGroupDirection =
    referencedGroupDirectionForPlacement(placement);
  if (referencedGroupDirection && activeGroup) {
    return {
      direction: referencedGroupDirection,
      referenceGroup: activeGroup.id,
    };
  }

  return undefined;
}

/** Returns the initial size for a current-group split. */
function panelSizeForPlacement(
  api: PanelOpenDockApi,
  placement: PanelOpenPlacement,
  activeGroup = activeGroupForApi(api),
): Pick<AddPanelParams, "initialHeight" | "initialWidth"> {
  if (!isCurrentGroupSplitPlacement(placement)) {
    return {};
  }

  if (!activeGroup) {
    return {};
  }

  if (placement === "split-left" || placement === "split-right") {
    return activeGroup.width
      ? { initialWidth: Math.max(1, Math.floor(activeGroup.width / 2)) }
      : {};
  }

  return activeGroup.height
    ? { initialHeight: Math.max(1, Math.floor(activeGroup.height / 2)) }
    : {};
}

/** Resizes both sides after inserting a panel that splits the current group. */
function resizeCurrentGroupSplit(
  activeGroup: FocusableGroup | undefined,
  openedGroup: FocusableGroup | undefined,
  placement: PanelOpenPlacement,
  size: Pick<AddPanelParams, "initialHeight" | "initialWidth">,
): void {
  if (!isCurrentGroupSplitPlacement(placement)) {
    return;
  }

  if (size.initialWidth) {
    activeGroup?.api?.setSize({ width: size.initialWidth });
    openedGroup?.api?.setSize({ width: size.initialWidth });
    return;
  }

  if (size.initialHeight) {
    activeGroup?.api?.setSize({ height: size.initialHeight });
    openedGroup?.api?.setSize({ height: size.initialHeight });
  }
}

/** Expands the edge group that owns a panel so focusing it reveals content. */
function expandPanelEdgeGroup(
  api: PanelOpenDockApi,
  panel: FocusablePanel | undefined,
): void {
  const location = panel?.api?.location;
  if (location?.type !== "edge" || !location.position) {
    return;
  }

  api.setEdgeGroupVisible?.(location.position, true);
  api.getEdgeGroup?.(location.position)?.expand();
}

/** Opens a panel, focuses an existing singleton, or skips when Dockview is unavailable. */
export function openOrFocusPanel(
  api: PanelOpenDockApi | undefined,
  panelId: string,
  componentName: string,
  title: string,
  placement: PanelOpenPlacement = "default",
): "skipped" | "focused" | "opened" {
  if (!api) {
    return "skipped";
  }

  const existingPanel = api.getPanel(panelId);
  if (existingPanel) {
    expandPanelEdgeGroup(api, existingPanel);
    existingPanel.focus();
    return "focused";
  }

  const activeGroup = activeGroupForApi(api);
  const size = panelSizeForPlacement(api, placement, activeGroup);
  const openedPanel = api.addPanel({
    id: panelId,
    component: componentName,
    title,
    params: {},
    position: panelPositionForPlacement(api, placement, activeGroup),
    ...size,
  }) as FocusablePanel | undefined;
  resizeCurrentGroupSplit(activeGroup, openedPanel?.group, placement, size);
  expandPanelEdgeGroup(api, openedPanel);
  return "opened";
}

/** Opens or focuses a panel using the shared panel definition identity. */
export function openOrFocusPanelDefinition(
  api: PanelOpenDockApi | undefined,
  definition: PanelDefinition,
  placement: PanelOpenPlacement = "default",
): "skipped" | "focused" | "opened" {
  return openOrFocusPanel(
    api,
    definition.panelId,
    definition.componentName,
    definition.title,
    placement,
  );
}
