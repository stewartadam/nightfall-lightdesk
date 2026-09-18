// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { ArrowsInIcon } from "@squidlab/phosphor-solid/arrows-in";
import { ArrowsOutIcon } from "@squidlab/phosphor-solid/arrows-out";
import { XIcon } from "@squidlab/phosphor-solid/x";
import {
  type CreateComponentOptions,
  createDockview,
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewWillDropEvent,
  type EdgeGroupPosition,
  type GroupPanelPartInitParameters,
  getPanelData,
  type IContentRenderer,
  type ITabRenderer,
  type PanelTransfer,
} from "dockview";
import type { ParentComponent, Setter } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  restoreSerializedLayout,
  type SerializedLayout,
} from "../../../../lib/dockview-layout";
import { areExperimentalFlowsEnabled } from "../../../../lib/experimental-features";
import { isVisualizerDefaultPanelEnabled } from "../../../../lib/feature-flags";
import { clearLayout, loadLayout } from "../../../../lib/layoutStorage";
import { getLogger } from "../../../../lib/logger";
import {
  type PanelDefinition,
  panelDefinitionByName,
} from "../../../../lib/panel-definitions";
import {
  getPanelLivenessEntries,
  type PanelLivenessEntry,
} from "../../../../lib/panel-liveness";
import {
  type BasePanelComponentProps,
  getComponentNames,
  getComponentRegistration,
} from "../../../../lib/panel-registry";
import {
  type PanelTabStatus,
  subscribePanelTabStatus,
} from "../../../../lib/panel-tab-status";
import { appearanceSettings } from "../../../../state/appearance";
import { openContextMenu } from "../../../providers/context-menu";
import { type AppIcon, renderIconComponent } from "../../../ui/icon";
import { Button } from "../../../ui/visual-language/button";
import { visualLanguageDockTheme } from "./dockview-host";
import { bindPanelAppearance } from "./panel-appearance";
import { bindPanelClipping } from "./panel-clipping";
import { bindPanelConstraints } from "./panel-constraints";
import "./dockview-app.css";

import { useWorkspaceActivity } from "../../../../lib/workspace-activity";

const log = getLogger(import.meta.url);

import "dockview/dist/styles/dockview.css";

const EDGE_DROP_TARGET_SIZE = 35;
const EDGE_DROP_HOLD_DELAY_MS = 500;
const HIDDEN_EDGE_GROUP_PADDING = 16;
export const EDGE_GROUP_COLLAPSED_SIZE = 34;
const PANEL_LIVENESS_CLOSE_DELAY_MS = 0;
const DOCKVIEW_ROOT_EDGE_ACTIVATION_SIZE = 10;
const DOCKVIEW_ROOT_EDGE_OVERLAY_SIZE = 20;
const DEFAULT_EDGE_GROUP_POSITIONS = [
  "left",
  "bottom",
  "right",
] as const satisfies readonly EdgeGroupPosition[];

type DefaultEdgeGroupPosition = (typeof DEFAULT_EDGE_GROUP_POSITIONS)[number];

const DEFAULT_EDGE_GROUP_IDS: Record<DefaultEdgeGroupPosition, string> = {
  bottom: "edge-Console",
  left: "edge-Programmer",
  right: "edge-Properties",
};

type SolidComponentType = ParentComponent<BasePanelComponentProps>;
let nextPortalEntryId = 0;

/**
 * Direct renderer for SolidJS components
 */
class SolidRenderer implements IContentRenderer {
  private id?: string;
  private portalEntryId?: number;
  private readonly _container: HTMLElement;
  private readonly _renderRoot: HTMLElement;
  private component: SolidComponentType;
  private panelAppearance?: ReturnType<typeof bindPanelAppearance>;

  /** Binds renderer ownership to one workspace rather than the app-wide panel ID. */
  constructor(
    component: SolidComponentType,
    private setPortals: Setter<PortalEntry[]>,
    private panelComponentById: Map<string, string>,
  ) {
    this.component = component;

    this._container = document.createElement("div");
    this._container.className = "h-full";

    this._renderRoot = document.createElement("div");
    this._renderRoot.className = "h-full overflow-auto";

    this._container.appendChild(this._renderRoot);
  }

  get element(): HTMLElement {
    return this._container;
  }

  /** Mounts panel content and keeps its appearance tied to Dockview's active panel. */
  init(parameters: GroupPanelPartInitParameters): void {
    this.panelAppearance = bindPanelAppearance(this._container, parameters.api);
    // Track panel identity
    this.id = parameters.api.id;
    const portalEntryId = nextPortalEntryId++;
    this.portalEntryId = portalEntryId;
    // Queue up a portal into the main root, converting the parameters passed to the panel component into props
    this.setPortals((prev) => [
      ...prev,
      {
        portalEntryId,
        id: parameters.api.id,
        component: this.component,
        props: {
          id: parameters.api.id,
          initialPanelId: parameters.api.id,
          panelApi: parameters.api,
          ...parameters.params,
        },
        mount: this._renderRoot,
      },
    ]);
  }

  /** Releases the appearance subscription and removes the panel's Solid portal. */
  dispose(): void {
    this.panelAppearance?.dispose();
    // Remove this panel's portal entry
    if (this.id && this.portalEntryId !== undefined) {
      const portalEntryId = this.portalEntryId;
      this.panelComponentById.delete(this.id);
      this.setPortals((prev) =>
        prev.filter((p) => p.portalEntryId !== portalEntryId),
      );
    }
  }
}

class IconTabRenderer implements ITabRenderer {
  private readonly _element: HTMLElement;
  private readonly _content: HTMLDivElement;
  private readonly _icon: HTMLSpanElement;
  private readonly _label: HTMLSpanElement;
  private readonly _action: HTMLDivElement;
  private readonly _closeIcon: HTMLSpanElement;
  private _title = "";
  private _iconComponent: AppIcon | undefined;
  private _status: PanelTabStatus | undefined;
  private _onDidTitleChange?: { dispose: () => void };
  private _removeStatusSubscription?: () => void;
  private _removePointerDown?: () => void;
  private _removeClick?: () => void;
  private _removeContextMenu?: () => void;

  /** Creates a tab using the component registrations of its own workspace. */
  constructor(private panelComponentById: Map<string, string>) {
    this._element = document.createElement("div");
    this._element.className = "dv-default-tab";

    this._content = document.createElement("div");
    this._content.className = "dv-default-tab-content";
    this._content.style.display = "inline-flex";
    this._content.style.alignItems = "center";
    this._content.style.gap = "6px";

    this._icon = document.createElement("span");
    this._icon.setAttribute("aria-hidden", "true");
    this._icon.style.width = "14px";
    this._icon.style.height = "14px";
    this._icon.style.display = "inline-block";
    this._icon.style.flexShrink = "0";

    this._label = document.createElement("span");
    this._label.style.overflow = "hidden";
    this._label.style.textOverflow = "ellipsis";

    this._action = document.createElement("div");
    this._action.className = "dv-default-tab-action";
    this._closeIcon = document.createElement("span");
    this._closeIcon.setAttribute("aria-hidden", "true");
    this._closeIcon.style.width = "14px";
    this._closeIcon.style.height = "14px";
    this._closeIcon.style.display = "inline-block";
    this._action.appendChild(this._closeIcon);
    renderIconComponent(this._closeIcon, XIcon, "size-3.5");

    this._content.appendChild(this._icon);
    this._content.appendChild(this._label);
    this._element.appendChild(this._content);
    this._element.appendChild(this._action);
    this.render();
  }

  get element(): HTMLElement {
    return this._element;
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this._title = parameters.title ?? "";
    this._element.dataset.dockviewPanelId = parameters.api.id;
    const componentName =
      this.panelComponentById.get(parameters.api.id) ??
      parameters.containerApi.getPanel(parameters.api.id)?.view
        .contentComponent;
    this._iconComponent = componentName
      ? getComponentRegistration(componentName)?.icon
      : undefined;

    this._onDidTitleChange = parameters.api.onDidTitleChange((event) => {
      this._title = event.title ?? "";
      this.render();
    });
    this._removeStatusSubscription = subscribePanelTabStatus(
      parameters.api.id,
      (status) => {
        this._status = status;
        this.render();
      },
    );
    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
    };
    this._action.addEventListener("pointerdown", onPointerDown);
    this._removePointerDown = () => {
      this._action.removeEventListener("pointerdown", onPointerDown);
    };

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      parameters.api.close();
    };
    this._action.addEventListener("click", onClick);
    this._removeClick = () => {
      this._action.removeEventListener("click", onClick);
    };

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      parameters.api.setActive();

      const panelsInGroup = () => [...parameters.api.group.panels];
      openContextMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            id: "close",
            label: "Close",
            icon: XIcon,
            onSelect: () => parameters.api.close(),
          },
          {
            id: "close-others",
            label: "Close Others in Group",
            disabled: panelsInGroup().length <= 1,
            onSelect: () => {
              for (const panel of panelsInGroup()) {
                if (panel.api.id !== parameters.api.id) {
                  panel.api.close();
                }
              }
            },
          },
          {
            id: "close-group",
            label: "Close All in Group",
            onSelect: () => {
              for (const panel of panelsInGroup()) {
                panel.api.close();
              }
            },
          },
          { id: "dock-tab-separator", type: "separator" },
          {
            id: "maximize",
            label: parameters.api.isMaximized()
              ? "Restore Group"
              : "Maximize Group",
            icon: parameters.api.isMaximized() ? ArrowsInIcon : ArrowsOutIcon,
            onSelect: () => {
              if (parameters.api.isMaximized()) {
                parameters.api.exitMaximized();
              } else {
                parameters.api.maximize();
              }
            },
          },
        ],
      });
    };
    this._element.addEventListener("contextmenu", onContextMenu);
    this._removeContextMenu = () => {
      this._element.removeEventListener("contextmenu", onContextMenu);
    };

    this.render();
  }

  dispose(): void {
    this._onDidTitleChange?.dispose();
    this._onDidTitleChange = undefined;
    this._removeStatusSubscription?.();
    this._removeStatusSubscription = undefined;
    this._removePointerDown?.();
    this._removePointerDown = undefined;
    this._removeClick?.();
    this._removeClick = undefined;
    this._removeContextMenu?.();
    this._removeContextMenu = undefined;
    renderIconComponent(this._icon, undefined, "size-3.5");
  }

  /** Renders the registered panel icon or its transient activity replacement. */
  private render(): void {
    if (this._label.textContent !== this._title) {
      this._label.textContent = this._title;
    }
    this._element.setAttribute(
      "aria-label",
      this._status === "saving" ? `${this._title}, saving` : this._title,
    );
    if (this._status) this._icon.dataset.panelTabStatus = this._status;
    else delete this._icon.dataset.panelTabStatus;

    const iconComponent =
      this._status === "saving" ? ArrowsClockwiseIcon : this._iconComponent;
    if (iconComponent) {
      renderIconComponent(
        this._icon,
        iconComponent,
        this._status === "saving" ? "size-3.5 animate-spin" : "size-3.5",
      );
      this._icon.style.display = "inline-block";
    } else {
      renderIconComponent(this._icon, undefined, "size-3.5");
      this._icon.style.display = "none";
    }
  }
}

// Define a structure for portal entries
interface PortalEntry {
  portalEntryId: number;
  id: string;
  component: SolidComponentType;
  props: object;
  mount: HTMLElement;
}

function ComponentMissing(props: { message: string }) {
  return (
    <div class="p-2">
      <div
        class="p-4 mb-4 text-sm text-red-800 rounded-lg dark:text-red-400 w-200"
        role="alert"
      >
        <div class="pb-2">
          <span class="font-medium mr-2">{props.message}</span>
        </div>
      </div>
    </div>
  );
}

function isNativeEditableContextTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  return Boolean(
    element.closest("input, textarea, select, [contenteditable='true']"),
  );
}

/** Returns whether a Dockview drop position belongs to a default edge group. */
function isDefaultEdgeGroupPosition(
  position: string,
): position is DefaultEdgeGroupPosition {
  return (DEFAULT_EDGE_GROUP_POSITIONS as readonly string[]).includes(position);
}

/** Returns the Dockview group backing one of the default edge slots. */
function getDefaultEdgeGroup(
  api: DockviewApi,
  position: DefaultEdgeGroupPosition,
): DockviewGroupPanel | undefined {
  return api.groups.find(
    (group) => group.id === DEFAULT_EDGE_GROUP_IDS[position],
  );
}

/** Hides default edge groups that currently have no panels. */
function hideEmptyDefaultEdgeGroups(api: DockviewApi): void {
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
function getHiddenDefaultEdgeDropTargets(
  api: DockviewApi,
  sourcePosition?: DefaultEdgeGroupPosition,
): DefaultEdgeGroupPosition[] {
  return DEFAULT_EDGE_GROUP_POSITIONS.filter((position) =>
    isHiddenDefaultEdgeDropTarget(api, position, sourcePosition),
  );
}

/** Returns the CSS classes for an invisible app-owned edge drop target. */
function edgeDropTargetClasses(position: DefaultEdgeGroupPosition): string {
  const base = "absolute z-50 bg-transparent";

  switch (position) {
    case "left":
      return `${base} bottom-0 left-0 top-0`;
    case "right":
      return `${base} bottom-0 right-0 top-0`;
    case "bottom":
      return `${base} bottom-0 left-0 right-0`;
  }
}

/** Returns the inline size for an app-owned edge drop target. */
function edgeDropTargetStyle(position: DefaultEdgeGroupPosition) {
  if (position === "bottom") {
    return {
      height: `${EDGE_DROP_TARGET_SIZE}px`,
    };
  }

  return {
    width: `${EDGE_DROP_TARGET_SIZE}px`,
  };
}

/** Returns Dockview selection classes for the app-owned edge drop highlight. */
function edgeDropTargetSelectionClasses(
  position: DefaultEdgeGroupPosition,
): string {
  const base = "dv-drop-target-selection";

  switch (position) {
    case "left":
      return `${base} dv-drop-target-left dv-drop-target-small-horizontal`;
    case "right":
      return `${base} dv-drop-target-right dv-drop-target-small-horizontal`;
    case "bottom":
      return `${base} dv-drop-target-bottom dv-drop-target-small-vertical`;
  }
}

/** Insets empty hidden side edges while reserving space for any armed drop target. */
function dockviewHostStyle(
  armedPosition: DefaultEdgeGroupPosition | undefined,
  hiddenPositions: DefaultEdgeGroupPosition[],
) {
  /** Keeps the drag preview inset larger than the resting workspace padding. */
  const inset = (position: DefaultEdgeGroupPosition) =>
    `${armedPosition === position ? EDGE_DROP_TARGET_SIZE : hiddenPositions.includes(position) ? HIDDEN_EDGE_GROUP_PADDING : 0}px`;

  return {
    bottom: armedPosition === "bottom" ? `${EDGE_DROP_TARGET_SIZE}px` : "0px",
    left: inset("left"),
    right: inset("right"),
  };
}

/** Returns whether the instant edge-drop modifier is pressed. */
function isEdgeDropModifierPressed(
  event: DragEvent | MouseEvent | PointerEvent,
): boolean {
  return event.altKey;
}

/** Resolves a pointer coordinate to one of the app-owned edge drop bands. */
function getEdgeDropPositionFromPoint(
  element: HTMLElement,
  clientX: number,
  clientY: number,
  targetPositions: readonly DefaultEdgeGroupPosition[],
): DefaultEdgeGroupPosition | undefined {
  const rect = element.getBoundingClientRect();
  const insideX = clientX >= rect.left && clientX <= rect.right;
  const insideY = clientY >= rect.top && clientY <= rect.bottom;
  if (!insideX || !insideY) return undefined;

  if (
    clientX <= rect.left + EDGE_DROP_TARGET_SIZE &&
    targetPositions.includes("left")
  ) {
    return "left";
  }
  if (
    clientX >= rect.right - EDGE_DROP_TARGET_SIZE &&
    targetPositions.includes("right")
  ) {
    return "right";
  }
  if (
    clientY >= rect.bottom - EDGE_DROP_TARGET_SIZE &&
    targetPositions.includes("bottom")
  ) {
    return "bottom";
  }
  return undefined;
}

/** Returns whether a Dockview transfer can be routed to a default edge group. */
function canMovePanelTransferToDefaultEdgeGroup(
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

/** Moves a Dockview drag transfer into one of the default edge groups. */
function movePanelTransferToDefaultEdgeGroup(
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

/** Moves root-edge drops into hidden edge groups instead of regular groups. */
function handleDefaultEdgeDrop(
  api: DockviewApi,
  event: DockviewWillDropEvent,
  shouldRouteToEdgeGroup: (
    position: DefaultEdgeGroupPosition,
    nativeEvent: DragEvent | PointerEvent,
  ) => boolean,
): void {
  if (event.kind !== "edge") return;
  if (!isDefaultEdgeGroupPosition(event.position)) return;
  if (!shouldRouteToEdgeGroup(event.position, event.nativeEvent)) return;

  if (
    movePanelTransferToDefaultEdgeGroup(api, event.position, event.getData())
  ) {
    event.preventDefault();
  }
}

/** Exposes the mounted workspace to layout activation and reset commands. */
export interface DockWorkspaceHandle {
  api: DockviewApi;
  reset: () => void;
  hasSessionLayout: () => boolean;
}

interface DockWorkspaceProps {
  initialLayout?: SerializedLayout;
  restoreSession?: boolean;
  onReady: (workspace: DockWorkspaceHandle) => void;
  onError: (error: unknown) => void;
}

/** Owns one Dockview and its Solid panels for the lifetime of a visited layout. */
export default function DockWorkspace(props: DockWorkspaceProps) {
  const workspaceActive = useWorkspaceActivity();
  let parentRef: HTMLDivElement | undefined;
  let dockviewHostRef: HTMLDivElement | undefined;
  const [portals, setPortals] = createSignal<PortalEntry[]>([]);
  const panelComponentById = new Map<string, string>();
  const appearance = useStore(appearanceSettings);
  /** Limits tab relocation to changes in the tab preference. */
  const tabPosition = createMemo(() => appearance().tabPosition);

  // parent ref is only available after onMount
  // Signal used to re-render component after onMount()
  const [api, setApi] = createSignal<DockviewApi | null>(null);
  const [hiddenEdgePositions, setHiddenEdgePositions] = createSignal<
    DefaultEdgeGroupPosition[]
  >([], {
    /** Avoids relayout when resizing leaves the same edges hidden. */
    equals: (previous, next) => previous.join() === next.join(),
  });
  const [edgeDropTargetsActive, setEdgeDropTargetsActive] = createSignal(false);
  const [edgeDropPreviewPosition, setEdgeDropPreviewPosition] =
    createSignal<DefaultEdgeGroupPosition>();
  const [hasSessionLayout, setHasSessionLayout] = createSignal(false);
  const [edgeDropArmedPosition, setEdgeDropArmedPosition] =
    createSignal<DefaultEdgeGroupPosition>();
  const [edgeDropTargetPositions, setEdgeDropTargetPositions] = createSignal<
    DefaultEdgeGroupPosition[]
  >([]);
  const pendingLivenessClosePanelIds = new Set<string>();
  let livenessCloseTimer: ReturnType<typeof setTimeout> | undefined;

  /** Returns whether a liveness registration currently requests panel closure. */
  const shouldCloseDeadPanel = (entry: PanelLivenessEntry) =>
    entry.closeWhenDead !== false && !entry.isAlive();

  /** Closes panels that remain dead after the liveness close delay. */
  const closePendingDeadPanels = () => {
    livenessCloseTimer = undefined;
    const dockApi = api();
    if (!dockApi) {
      pendingLivenessClosePanelIds.clear();
      return;
    }

    const deadPanelIds = new Set(
      getPanelLivenessEntries()
        .filter(
          (entry) =>
            entry.workspaceActive === workspaceActive &&
            pendingLivenessClosePanelIds.has(entry.panelId),
        )
        .filter(shouldCloseDeadPanel)
        .map((entry) => entry.panelId),
    );
    pendingLivenessClosePanelIds.clear();

    for (const panelId of deadPanelIds) {
      try {
        dockApi.getPanel(panelId)?.api.close();
      } catch (error) {
        log.warn("Ignoring stale liveness panel close request", error);
      }
    }
  };

  /** Schedules a panel close pass outside the current reactive update. */
  const scheduleDeadPanelClose = (panelId: string) => {
    pendingLivenessClosePanelIds.add(panelId);
    if (livenessCloseTimer !== undefined) return;
    livenessCloseTimer = setTimeout(
      closePendingDeadPanels,
      PANEL_LIVENESS_CLOSE_DELAY_MS,
    );
  };

  /** Watches mounted panel liveness predicates and delegates stale closes. */
  createEffect(() => {
    if (!api()) return;

    for (const entry of getPanelLivenessEntries()) {
      if (
        entry.workspaceActive === workspaceActive &&
        shouldCloseDeadPanel(entry)
      ) {
        scheduleDeadPanelClose(entry.panelId);
      }
    }
  });

  /** Cancels shell-owned panel liveness work when DockApp unmounts. */
  onCleanup(() => {
    if (livenessCloseTimer !== undefined) {
      clearTimeout(livenessCloseTimer);
    }
    pendingLivenessClosePanelIds.clear();
  });

  onMount(() => {
    log.trace("DockApp mounting");
    if (!parentRef || !dockviewHostRef) return;
    let edgeDropHoldTimeout: ReturnType<typeof setTimeout> | undefined;
    let edgeDropHoldPosition: DefaultEdgeGroupPosition | undefined;
    let edgeDropPreviewStartedAt: number | undefined;
    let edgeDropDragEndTarget: HTMLElement | undefined;
    let dockviewApiPublished = false;
    let publishApiFrame: number | undefined;
    let publishApiResizeObserver: ResizeObserver | undefined;

    // Initialize dockview
    const dockApi = createDockview(dockviewHostRef, {
      theme: visualLanguageDockTheme,
      defaultHeaderPosition: tabPosition(),
      defaultTabComponent: "PanelTab",
      createComponent: (options: CreateComponentOptions) => {
        const componentId = options.name;
        if (!componentId) {
          throw new Error("Component ID is required in params");
        }
        panelComponentById.set(options.id, componentId);
        const registration = getComponentRegistration(componentId);
        if (!registration) {
          const availableComponents = getComponentNames().join(", ");
          log.error(
            `Component ${componentId} not found in registry. Available components: ${availableComponents}`,
          );
          return new SolidRenderer(
            (() => (
              <ComponentMissing
                message={`Could not find component ${componentId}.`}
              />
            )) as unknown as SolidComponentType,
            setPortals,
            panelComponentById,
          );
        }

        try {
          return new SolidRenderer(
            registration.component as unknown as SolidComponentType,
            setPortals,
            panelComponentById,
          );
        } catch (error) {
          log.error("Error creating component:", error);
          throw error;
        }
      },
      createTabComponent: (options: CreateComponentOptions) => {
        if (options.name === "PanelTab") {
          return new IconTabRenderer(panelComponentById);
        }
        return undefined;
      },
      // Ensures that scroll position is not reset when panels are re-rendered
      defaultRenderer: "always",
      dndEdges: {
        activationSize: {
          type: "pixels",
          value: DOCKVIEW_ROOT_EDGE_ACTIVATION_SIZE,
        },
        size: { type: "pixels", value: DOCKVIEW_ROOT_EDGE_OVERLAY_SIZE },
      },
    });

    const panelConstraints = bindPanelConstraints(
      dockApi,
      visualLanguageDockTheme.gap ?? 0,
    );
    const panelClipping = bindPanelClipping(dockApi, dockviewHostRef);

    /** Moves workspace tab strips while preserving structural edge tabs and panel state. */
    const applyTabPosition = () => {
      const position = tabPosition();
      dockApi.updateOptions({ defaultHeaderPosition: position });
      for (const group of dockApi.groups) {
        if (group.api.location.type !== "edge") {
          group.api.setHeaderPosition(position);
        }
      }
    };
    /** Applies appearance changes to existing groups without reconstructing their panels. */
    createEffect(applyTabPosition);
    const disposeTabPositionAfterRestore =
      dockApi.onDidLayoutFromJSON(applyTabPosition);

    const sessionLayout =
      props.initialLayout ?? (props.restoreSession ? loadLayout() : null);
    if (sessionLayout) {
      try {
        restoreSerializedLayout(dockApi, sessionLayout);
        setHasSessionLayout(true);
      } catch (error) {
        log.warn("Failed to restore local Dockview session layout", error);
        if (props.initialLayout) props.onError(error);
        setHasSessionLayout(false);
      }
    } else {
      setHasSessionLayout(false);
    }

    const disposeEdgeDrop = dockApi.onWillDrop((event) => {
      handleDefaultEdgeDrop(dockApi, event, (position, nativeEvent) => {
        if (!edgeDropTargetPositions().includes(position)) {
          return false;
        }

        return (
          edgeDropArmedPosition() === position ||
          (edgeDropPreviewPosition() === position &&
            edgeDropPreviewStartedAt !== undefined &&
            performance.now() - edgeDropPreviewStartedAt >=
              EDGE_DROP_HOLD_DELAY_MS) ||
          isEdgeDropModifierPressed(nativeEvent)
        );
      });
    });
    const disposeHideEmptyAfterRemove = dockApi.onDidRemovePanel(() => {
      hideEmptyDefaultEdgeGroups(dockApi);
    });
    const disposeHideEmptyAfterMove = dockApi.onDidMovePanel(() => {
      hideEmptyDefaultEdgeGroups(dockApi);
    });
    const disposeHideEmptyAfterRestore = dockApi.onDidLayoutFromJSON(() => {
      hideEmptyDefaultEdgeGroups(dockApi);
    });
    /** Refreshes resting insets after panels, visibility, or restored layouts change. */
    const syncHiddenEdgePositions = () => {
      setHiddenEdgePositions(getHiddenDefaultEdgeDropTargets(dockApi));
    };
    const disposeHiddenEdgePadding = dockApi.onDidLayoutChange(
      syncHiddenEdgePositions,
    );
    syncHiddenEdgePositions();
    const clearEdgeDropHold = () => {
      if (edgeDropHoldTimeout !== undefined) {
        clearTimeout(edgeDropHoldTimeout);
        edgeDropHoldTimeout = undefined;
      }
      edgeDropHoldPosition = undefined;
    };
    const resetEdgeDropAffordance = () => {
      clearEdgeDropHold();
      setEdgeDropPreviewPosition(undefined);
      edgeDropPreviewStartedAt = undefined;
      setEdgeDropArmedPosition(undefined);
    };
    const updateEdgeDropAffordance = (
      event: DragEvent | MouseEvent | PointerEvent,
    ) => {
      if (!edgeDropTargetsActive()) return;

      const edgePosition = getEdgeDropPositionFromPoint(
        parentRef,
        event.clientX,
        event.clientY,
        edgeDropTargetPositions(),
      );
      if (!edgePosition) {
        resetEdgeDropAffordance();
        return;
      }

      if (edgeDropPreviewPosition() !== edgePosition) {
        edgeDropPreviewStartedAt = performance.now();
        setEdgeDropPreviewPosition(edgePosition);
      }
      if (edgeDropArmedPosition() && edgeDropArmedPosition() !== edgePosition) {
        setEdgeDropArmedPosition(undefined);
      }

      if (isEdgeDropModifierPressed(event)) {
        clearEdgeDropHold();
        setEdgeDropArmedPosition(edgePosition);
        return;
      }

      if (
        edgeDropArmedPosition() === edgePosition ||
        edgeDropHoldPosition === edgePosition
      ) {
        return;
      }

      clearEdgeDropHold();
      edgeDropHoldPosition = edgePosition;
      edgeDropHoldTimeout = setTimeout(() => {
        if (
          edgeDropTargetsActive() &&
          edgeDropPreviewPosition() === edgePosition
        ) {
          setEdgeDropArmedPosition(edgePosition);
        }
        edgeDropHoldTimeout = undefined;
        edgeDropHoldPosition = undefined;
      }, EDGE_DROP_HOLD_DELAY_MS);
    };
    const handleWindowEdgeDragTracking = (
      event: DragEvent | MouseEvent | PointerEvent,
    ) => {
      updateEdgeDropAffordance(event);
    };
    const disableEdgeDropTargets = () => {
      setEdgeDropTargetsActive(false);
      resetEdgeDropAffordance();
      setEdgeDropTargetPositions([]);
      window.removeEventListener(
        "dragover",
        handleWindowEdgeDragTracking,
        true,
      );
      window.removeEventListener(
        "pointermove",
        handleWindowEdgeDragTracking,
        true,
      );
      window.removeEventListener(
        "mousemove",
        handleWindowEdgeDragTracking,
        true,
      );
      window.removeEventListener("mouseup", handleWindowEdgeDrop, true);
      window.removeEventListener("pointerup", handleWindowEdgeDrop, true);
      edgeDropDragEndTarget?.removeEventListener(
        "dragend",
        handleWindowEdgeDrop,
      );
      edgeDropDragEndTarget = undefined;
    };
    const handleWindowEdgeDrop = (
      event: DragEvent | MouseEvent | PointerEvent,
    ) => {
      if (!edgeDropTargetsActive()) return;

      const edgePosition = getEdgeDropPositionFromPoint(
        parentRef,
        event.clientX,
        event.clientY,
        edgeDropTargetPositions(),
      );
      if (
        edgePosition &&
        (edgeDropArmedPosition() === edgePosition ||
          (edgeDropPreviewPosition() === edgePosition &&
            edgeDropPreviewStartedAt !== undefined &&
            performance.now() - edgeDropPreviewStartedAt >=
              EDGE_DROP_HOLD_DELAY_MS) ||
          isEdgeDropModifierPressed(event)) &&
        movePanelTransferToDefaultEdgeGroup(dockApi, edgePosition)
      ) {
        event.preventDefault();
        event.stopPropagation();
      }

      disableEdgeDropTargets();
    };
    const enableEdgeDropTargets = (
      nativeEvent: DragEvent | PointerEvent,
      sourcePosition?: DefaultEdgeGroupPosition,
    ) => {
      const targetPositions = getHiddenDefaultEdgeDropTargets(
        dockApi,
        sourcePosition,
      );
      setEdgeDropTargetPositions(targetPositions);
      if (targetPositions.length === 0) return;

      setEdgeDropTargetsActive(true);

      const target = nativeEvent.target;
      if (target instanceof HTMLElement) {
        edgeDropDragEndTarget = target;
        target.addEventListener("dragend", handleWindowEdgeDrop, {
          once: true,
        });
      }
      window.addEventListener("dragover", handleWindowEdgeDragTracking, {
        capture: true,
      });
      window.addEventListener("pointermove", handleWindowEdgeDragTracking, {
        capture: true,
      });
      window.addEventListener("mousemove", handleWindowEdgeDragTracking, {
        capture: true,
      });
      window.addEventListener("mouseup", handleWindowEdgeDrop, {
        capture: true,
        once: true,
      });
      window.addEventListener("pointerup", handleWindowEdgeDrop, {
        capture: true,
        once: true,
      });
    };
    const disposeEnableEdgeDropOnPanelDrag = dockApi.onWillDragPanel(
      (event) => {
        const location = event.panel.api.location;
        const sourcePosition =
          location.type === "edge" &&
          isDefaultEdgeGroupPosition(location.position)
            ? location.position
            : undefined;
        enableEdgeDropTargets(event.nativeEvent, sourcePosition);
      },
    );
    const disposeEnableEdgeDropOnGroupDrag = dockApi.onWillDragGroup(
      (event) => {
        const location = event.group.api.location;
        const sourcePosition =
          location.type === "edge" &&
          isDefaultEdgeGroupPosition(location.position)
            ? location.position
            : undefined;
        enableEdgeDropTargets(event.nativeEvent, sourcePosition);
      },
    );
    const disposeDisableEdgeDropAfterDrop = dockApi.onDidDrop(
      disableEdgeDropTargets,
    );

    /** Publishes the Dockview API after the host has measurable dimensions. */
    const publishDockviewApi = () => {
      if (dockviewApiPublished) return true;

      const width = dockviewHostRef?.clientWidth ?? 0;
      const height = dockviewHostRef?.clientHeight ?? 0;
      if (width <= 0 || height <= 0) return false;

      dockApi.layout(width, height, true);
      setApi(dockApi);
      props.onReady({
        api: dockApi,
        reset: () => createDefaultLayout(dockApi),
        hasSessionLayout,
      });
      dockviewApiPublished = true;
      publishApiResizeObserver?.disconnect();
      publishApiResizeObserver = undefined;
      if (publishApiFrame !== undefined) {
        window.cancelAnimationFrame(publishApiFrame);
        publishApiFrame = undefined;
      }
      return true;
    };

    if (!publishDockviewApi() && dockviewHostRef) {
      publishApiResizeObserver = new ResizeObserver(() => {
        publishDockviewApi();
      });
      publishApiResizeObserver.observe(dockviewHostRef);
      publishApiFrame = window.requestAnimationFrame(() => {
        publishDockviewApi();
      });
    }

    onCleanup(() => {
      log.trace("DockApp unmounting");
      publishApiResizeObserver?.disconnect();
      if (publishApiFrame !== undefined) {
        window.cancelAnimationFrame(publishApiFrame);
      }
      disposeTabPositionAfterRestore.dispose();
      panelConstraints.dispose();
      panelClipping.dispose();
      disposeEdgeDrop.dispose();
      disposeHideEmptyAfterRemove.dispose();
      disposeHideEmptyAfterMove.dispose();
      disposeHideEmptyAfterRestore.dispose();
      disposeHiddenEdgePadding.dispose();
      disposeEnableEdgeDropOnPanelDrag.dispose();
      disposeEnableEdgeDropOnGroupDrag.dispose();
      disposeDisableEdgeDropAfterDrop.dispose();
      setApi(null);
      dockApi.dispose();
    });
  });

  // Function to create the default layout
  function createDefaultLayout(api: DockviewApi) {
    /** Removes structural edge slots that survive Dockview's panel clear. */
    const removeDefaultEdgeGroups = () => {
      for (const edgePosition of DEFAULT_EDGE_GROUP_POSITIONS) {
        if (api.getEdgeGroup(edgePosition)) {
          api.removeEdgeGroup(edgePosition);
        }
      }
    };

    /** Collapses seeded edge groups so inactive panels do not reserve empty content panes. */
    const collapseDefaultEdgeGroups = () => {
      for (const edgePosition of DEFAULT_EDGE_GROUP_POSITIONS) {
        api.getEdgeGroup(edgePosition)?.collapse();
      }
    };

    // Clear the saved layout and panel UI
    clearLayout();
    removeDefaultEdgeGroups();
    api.clear();

    // Helper function to add a panel with proper typing and error handling
    const addPanel = <T extends Record<string, unknown>>(
      definition: PanelDefinition,
      position: {
        direction: string;
        referencePanel?: string;
        referenceGroup?: string;
      } = {
        direction: "right",
      },
      params: T = {} as T,
      inactive = false,
    ) => {
      const { componentName, panelId, title } = definition;
      // Verify component exists before trying to create it
      const registration = getComponentRegistration(componentName);
      if (!registration) {
        const available = getComponentNames().join(", ");
        log.error(
          `Attempted to create panel with unregistered component: ${componentName}`,
          {
            panelId,
            availableComponents: available,
          },
        );
        throw new Error(
          `Cannot create panel: component "${componentName}" is not registered. Available: ${available}`,
        );
      }

      log.debug(`Creating panel ${panelId} with component ${componentName}`);

      try {
        return api.addPanel({
          id: panelId,
          component: componentName,
          title,
          position,
          params,
          inactive,
        });
      } catch (error) {
        log.error(
          `Failed to create panel ${panelId} with component ${componentName}:`,
          error,
        );
        throw error;
      }
    };

    /** Creates a permanent collapsible edge group and seeds its first panel. */
    const addEdgePanel = (
      edgePosition: EdgeGroupPosition,
      groupId: string,
      definition: PanelDefinition,
      initialSize: number,
    ) => {
      api.addEdgeGroup(edgePosition, {
        collapsedSize: EDGE_GROUP_COLLAPSED_SIZE,
        id: groupId,
        initialSize,
        minimumSize:
          edgePosition === "left" || edgePosition === "right"
            ? definition.minWidth
            : definition.minHeight,
      });

      return addPanel(
        definition,
        {
          referenceGroup: groupId,
          direction: "within",
        },
        {},
        true,
      );
    };

    addEdgePanel(
      "left",
      DEFAULT_EDGE_GROUP_IDS.left,
      panelDefinitionByName("ProgrammerGrid"),
      360,
    );

    addEdgePanel(
      "bottom",
      DEFAULT_EDGE_GROUP_IDS.bottom,
      panelDefinitionByName("CommandLine"),
      260,
    );

    addEdgePanel(
      "right",
      DEFAULT_EDGE_GROUP_IDS.right,
      panelDefinitionByName("PropertiesInspector"),
      340,
    );

    // Build the show-object tabs in the left column.
    const cuePanel = addPanel(panelDefinitionByName("CueList"), {
      direction: "left",
    });

    addPanel(panelDefinitionByName("SequenceList"), {
      referencePanel: cuePanel.id,
      direction: "within",
    });

    const fxListDefinition = panelDefinitionByName("FxList");
    addPanel(fxListDefinition, {
      referencePanel: cuePanel.id,
      direction: "within",
    });

    const flowListDefinition = panelDefinitionByName("FlowList");
    if (areExperimentalFlowsEnabled()) {
      addPanel(flowListDefinition, {
        referencePanel: fxListDefinition.panelId,
        direction: "within",
      });
    }

    const groupsDefinition = panelDefinitionByName("GroupsPanel");
    addPanel(groupsDefinition, {
      referencePanel: fxListDefinition.panelId,
      direction: "within",
    });

    addPanel(panelDefinitionByName("ClipList"), {
      referencePanel: groupsDefinition.panelId,
      direction: "within",
    });

    // Build right column: Fixtures, Programmer, 3D Visualizer
    const fixturesPanel = addPanel(panelDefinitionByName("FixtureGrid"));

    if (isVisualizerDefaultPanelEnabled()) {
      addPanel(panelDefinitionByName("Visualizer"), {
        referencePanel: fixturesPanel.id,
        direction: "within",
      });
    }

    collapseDefaultEdgeGroups();

    const width = dockviewHostRef?.clientWidth ?? api.width;
    const height = dockviewHostRef?.clientHeight ?? api.height;
    if (width > 0 && height > 0) {
      requestAnimationFrame(() => {
        collapseDefaultEdgeGroups();
        api.layout(width, height, true);
      });
    }
  }

  return (
    <div
      ref={parentRef}
      class="relative h-full min-h-0 w-full overflow-hidden"
      onContextMenu={(event) => {
        if (isNativeEditableContextTarget(event.target)) return;
        event.preventDefault();
      }}
    >
      <div
        ref={dockviewHostRef}
        class="absolute left-0 right-0 top-0 bottom-0 transition-[left,right,bottom] duration-150 ease-out"
        data-testid="dockview-host"
        style={dockviewHostStyle(
          edgeDropArmedPosition(),
          hiddenEdgePositions(),
        )}
      />
      {edgeDropTargetsActive() && (
        <For each={edgeDropTargetPositions()}>
          {(edgePosition) => (
            <div
              aria-hidden="true"
              class={edgeDropTargetClasses(edgePosition)}
              classList={{
                "pointer-events-auto": edgeDropArmedPosition() === edgePosition,
                "pointer-events-none": edgeDropArmedPosition() !== edgePosition,
              }}
              data-testid={`dockview-edge-drop-zone-${edgePosition}`}
              onDragOver={(event) => {
                const dockApi = api();
                if (!dockApi || edgeDropArmedPosition() !== edgePosition)
                  return;
                if (
                  !canMovePanelTransferToDefaultEdgeGroup(dockApi, edgePosition)
                ) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                if (event.dataTransfer) {
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                const dockApi = api();
                if (!dockApi || edgeDropArmedPosition() !== edgePosition)
                  return;
                if (
                  movePanelTransferToDefaultEdgeGroup(dockApi, edgePosition)
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  setEdgeDropTargetsActive(false);
                  setEdgeDropPreviewPosition(undefined);
                  setEdgeDropArmedPosition(undefined);
                  setEdgeDropTargetPositions([]);
                }
              }}
              onPointerUp={(event) => {
                const dockApi = api();
                if (!dockApi || edgeDropArmedPosition() !== edgePosition)
                  return;
                if (
                  movePanelTransferToDefaultEdgeGroup(dockApi, edgePosition)
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  setEdgeDropTargetsActive(false);
                  setEdgeDropPreviewPosition(undefined);
                  setEdgeDropArmedPosition(undefined);
                  setEdgeDropTargetPositions([]);
                }
              }}
              style={edgeDropTargetStyle(edgePosition)}
            >
              {edgeDropArmedPosition() === edgePosition && (
                <div class="nightfall-dockview-edge-drop-target dv-drop-target h-full w-full">
                  <div class="dv-drop-target-dropzone">
                    <div class={edgeDropTargetSelectionClasses(edgePosition)} />
                  </div>
                </div>
              )}
            </div>
          )}
        </For>
      )}
      {/* Render all panel portals in the main Solid root so they share context */}
      <For each={portals()}>
        {(entry) => {
          const Component =
            entry.component as unknown as ParentComponent<object>;
          return (
            // Portals are wrapped a plain div, so tell CSS to ignore it - see https://github.com/solidjs/solid/issues/1873
            <Portal
              mount={entry.mount}
              ref={(x) => {
                x.className = `${entry.id} contents`;
              }}
            >
              <ErrorBoundary
                fallback={(err: Error, reset) => (
                  <div class="p-2">
                    <div
                      class="p-4 mb-4 text-sm text-red-800 rounded-lg dark:text-red-400 w-200"
                      role="alert"
                    >
                      <div class="pb-2">
                        <span class="font-medium mr-2">
                          Error rendering component: {err.message}
                        </span>

                        <Button
                          size="compact"
                          variant="primary"
                          type="button"
                          onClick={reset}
                          class="text-center items-center"
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke-width="1.5"
                            stroke="currentColor"
                            class="w-3 h-3 text-white me-2"
                          >
                            <path
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
                            />
                          </svg>
                          Retry
                        </Button>
                      </div>

                      <pre>{err.stack}</pre>
                    </div>
                  </div>
                )}
              >
                <Component {...entry.props} />
              </ErrorBoundary>
            </Portal>
          );
        }}
      </For>
    </div>
  );
}
