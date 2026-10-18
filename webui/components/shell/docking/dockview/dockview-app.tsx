// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  type CreateComponentOptions,
  createDockview,
  type DockviewApi,
} from "dockview";
import type { ParentComponent } from "solid-js";
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
import { openErrorBugReport } from "../../../../lib/feedback";
import { loadLayout } from "../../../../lib/layoutStorage";
import { getLogger } from "../../../../lib/logger";
import {
  getComponentNames,
  getComponentRegistration,
} from "../../../../lib/panel-registry";
import { describeUncaughtError } from "../../../../lib/uncaught-error";
import { useWorkspaceActivity } from "../../../../lib/workspace-activity";
import { appearanceSettings } from "../../../../state/appearance";
import { ErrorFallback } from "../../../ui/error-fallback";
import { ScrollIndicators } from "../../../ui/scroll-area";
import { Button } from "../../../ui/visual-language/button";
import { bindCompactPresentation } from "./compact-presentation";
import { createDeadPanelController } from "./dead-panel-controller";
import { createDefaultLayout } from "./default-layout";
import { visualLanguageDockTheme } from "./dockview-host";
import {
  edgeDropTargetClasses,
  edgeDropTargetSelectionClasses,
  edgeDropTargetStyle,
} from "./edge-drop-geometry";
import { createEdgeGroupDropController } from "./edge-group-drop-controller";
import { IconTabRenderer } from "./icon-tab-renderer";
import { bindPanelClipping } from "./panel-clipping";
import { bindPanelConstraints } from "./panel-constraints";
import {
  type PortalEntry,
  type SolidComponentType,
  SolidRenderer,
} from "./solid-panel-renderer";
import "./dockview-app.css";
import "dockview/dist/styles/dockview.css";

const log = getLogger(import.meta.url);

const DOCKVIEW_ROOT_EDGE_ACTIVATION_SIZE = 10;
const DOCKVIEW_ROOT_EDGE_OVERLAY_SIZE = 20;

/** Placeholder panel content shown when a layout names an unregistered component. */
function ComponentMissing(props: { message: string }) {
  return (
    <div class="p-2">
      <div class="p-4 mb-4 text-sm text-red-400 rounded-lg w-200" role="alert">
        <div class="pb-2">
          <span class="font-medium mr-2">{props.message}</span>
        </div>
      </div>
    </div>
  );
}

/** Returns whether a context-menu target should keep the browser's native menu. */
function isNativeEditableContextTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  return Boolean(
    element.closest("input, textarea, select, [contenteditable='true']"),
  );
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
  /** Presents one full-width panel at a time for the compact shell; never persisted. */
  compact?: boolean;
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
  const [hasSessionLayout, setHasSessionLayout] = createSignal(false);

  const edgeDrop = createEdgeGroupDropController({ api });
  createDeadPanelController({ api, workspaceActive });

  onMount(() => {
    log.trace("DockApp mounting");
    if (!parentRef || !dockviewHostRef) return;
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

    // Docked minimums would make a compact panel wider than the screen; there
    // the panel takes the full width and scrolls its own content instead.
    const panelSizing = props.compact
      ? [bindCompactPresentation(dockApi)]
      : [
          bindPanelConstraints(dockApi, visualLanguageDockTheme.gap ?? 0),
          bindPanelClipping(dockApi, dockviewHostRef),
        ];

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

    const edgeDropBinding = edgeDrop.bind(dockApi, parentRef);

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
        reset: () =>
          createDefaultLayout(dockApi, {
            host: dockviewHostRef,
            compact: props.compact,
          }),
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
      for (const binding of panelSizing) binding.dispose();
      edgeDropBinding.dispose();
      setApi(null);
      dockApi.dispose();
    });
  });

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
        style={edgeDrop.hostStyle()}
      />
      {edgeDrop.targetsActive() && (
        <For each={edgeDrop.targetPositions()}>
          {(edgePosition) => (
            <div
              aria-hidden="true"
              class={edgeDropTargetClasses(edgePosition)}
              classList={{
                "pointer-events-auto":
                  edgeDrop.armedPosition() === edgePosition,
                "pointer-events-none":
                  edgeDrop.armedPosition() !== edgePosition,
              }}
              data-testid={`dockview-edge-drop-zone-${edgePosition}`}
              onDragOver={(event) =>
                edgeDrop.handleZoneDragOver(event, edgePosition)
              }
              onDrop={(event) => edgeDrop.handleZoneDrop(event, edgePosition)}
              onPointerUp={(event) =>
                edgeDrop.handleZoneDrop(event, edgePosition)
              }
              style={edgeDropTargetStyle(edgePosition)}
            >
              {edgeDrop.armedPosition() === edgePosition && (
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
          const content = (
            // Portals are wrapped a plain div, so tell CSS to ignore it - see https://github.com/solidjs/solid/issues/1873
            <Portal
              mount={entry.mount}
              ref={(x) => {
                x.className = `${entry.id} contents`;
              }}
            >
              <ErrorBoundary
                fallback={(err, reset) => (
                  <ErrorFallback
                    title="This panel failed to render"
                    error={err}
                    reset={reset}
                    actions={
                      <Button
                        size="compact"
                        onClick={() =>
                          openErrorBugReport({
                            ...describeUncaughtError(err, "error"),
                            source: `panel ${entry.id}`,
                          })
                        }
                      >
                        Report Bug
                      </Button>
                    }
                  />
                )}
              >
                <Component {...entry.props} />
              </ErrorBoundary>
            </Portal>
          );
          return (
            <>
              {content}
              <Portal
                mount={entry.scrollFrame}
                ref={(x) => {
                  x.className = "contents";
                }}
              >
                <ScrollIndicators viewport={entry.mount} structureOnly />
              </Portal>
            </>
          );
        }}
      </For>
    </div>
  );
}
