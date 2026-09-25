// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CubeIcon } from "@squidlab/phosphor-solid/cube";
import { EraserIcon } from "@squidlab/phosphor-solid/eraser";
import { LightbulbIcon } from "@squidlab/phosphor-solid/lightbulb";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
/**
 * Visualizer canvas component.
 * Handles Three.js renderer lifecycle and browser events.
 *
 * Supports two rendering modes:
 * 1. OffscreenCanvas + Worker (if supported) - rendering runs in background thread
 * 2. Main thread (fallback) - traditional rendering on main thread
 *
 * Uses Comlink for worker communication, providing a clean typed API.
 */

import { useStore } from "@nanostores/solid";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import {
  removePatchBindingsForFixtureIds,
  sendDeleteFixture,
  sendFixturePlacementUpdates,
} from "../../../lib/fixture-service";
import {
  focusTrackedComponent,
  registerComponentFocus,
  registerKeyboardShortcut,
  useKeyboardShortcut,
} from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import { setStoreAction } from "../../../lib/nanostore-action";
import {
  deleteSceneObject,
  updateSceneObjectPlacement,
} from "../../../lib/scene-object-service";
import {
  applyVisualizerSelectionModifiers,
  combineVisualizerSelectionUids,
  orderedUidListsEqual,
} from "../../../lib/visualizer-selection";
import {
  activeSelectionSpanTargets,
  bindings,
  dockApi,
  fixtures as fixturesStore,
  programmerSelection,
  programmerState,
  sceneObjects as sceneObjectsStore,
  visualizerEditSelection,
  visualizerSceneObjectSelection,
  visualizerStats,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { useObjectPatchWizard } from "../../object-library";
import { usePatchWizard } from "../../patch";
import { useVisualizerContext } from "../context/visualizer-context";
import type { VisualizerCanvasApi } from "../controllers/visualizer-canvas-api";
import { resetCameraPointerDragForRenderer } from "../interactions/camera-drag-reset";
import { useMeasureToolInteraction } from "../interactions/use-measure-tool-interaction";
import { useMoveToolInteraction } from "../interactions/use-move-tool-interaction";
import { useRotateToolInteraction } from "../interactions/use-rotate-tool-interaction";
import { useSelectionToolInteraction } from "../interactions/use-selection-tool-interaction";
import { createPointerModeRouter } from "../interactions/use-visualizer-pointer-mode-router";
import type { VisualizerScreenPoint } from "../rendering/renderers/renderer-api";
import { useFixtures } from "../services/use-fixtures";
import { useSceneObjects } from "../services/use-scene-objects";
import { useVisualizerRendererLifecycle } from "../services/use-visualizer-renderer-lifecycle";
import { useVisualizerRendererSync } from "../services/use-visualizer-renderer-sync";
import {
  visualizerCameraRotationMode,
  visualizerHighlightSelection,
  visualizerShowOrbitTargetIndicator,
} from "../state/settings";

const log = getLogger(import.meta.url);

export interface VisualizerCanvasProps {
  /** CSS class name */
  class?: string;
  /** Callback to receive the canvas API */
  apiRef?: (api: VisualizerCanvasApi) => void;
  /** Force main thread rendering even if OffscreenCanvas is available */
  forceMainThread?: boolean;
}

type Axis = "x" | "y" | "z";

const MINI_AXIS_COLORS: Record<Axis, string> = {
  x: "#ef4444",
  y: "#22c55e",
  z: "#3b82f6",
};

export const VisualizerCanvas: Component<VisualizerCanvasProps> = (props) => {
  const workspaceActive = useWorkspaceActivity();
  const context = useVisualizerContext();
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  const fixtures = useFixtures();
  const sceneObjects = useSceneObjects();
  const $programmerSelection = useStore(programmerSelection);
  const $programmerState = useStore(programmerState);
  const $visualizerSceneObjectSelection = useStore(
    visualizerSceneObjectSelection,
  );
  const $visualizerEditSelection = useStore(visualizerEditSelection);
  const $activeSelectionSpanTargets = useStore(activeSelectionSpanTargets);
  const $bindings = useStore(bindings);
  const $dockApi = useStore(dockApi);
  const { openWizard: openFixtureWizard } = usePatchWizard();
  const { openWizard: openObjectWizard } = useObjectPatchWizard();
  const $highlightSelection = useStore(visualizerHighlightSelection);
  const $rotationMode = useStore(visualizerCameraRotationMode);
  const $showOrbitTargetIndicator = useStore(
    visualizerShowOrbitTargetIndicator,
  );
  const $fixturesStore = useStore(fixturesStore);
  const $sceneObjectsStore = useStore(sceneObjectsStore);
  const $visualizerStats = useStore(visualizerStats);
  const [, setAxisOverlay] = createSignal<{
    centerX: number;
    centerY: number;
    lockedAxis: Axis | null;
  } | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = createSignal(false);

  const getToolMode = () => context.toolMode();

  const applySceneObjectPlacementPreviewUpdate = (
    uid: string,
    update: (placement: {
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number };
    }) => void,
  ) => {
    const sceneObject = sceneObjectsStore.get()[uid];
    if (!sceneObject) return;

    const updatedSceneObject = {
      ...sceneObject,
      placement: {
        ...sceneObject.placement,
        position: { ...sceneObject.placement.position },
        rotation: { ...sceneObject.placement.rotation },
      },
    };
    update(updatedSceneObject.placement);
    setStoreAction(sceneObjectsStore, "Update Visualizer Scene Object", {
      ...sceneObjectsStore.get(),
      [uid]: updatedSceneObject,
    });
  };

  const isSelectionMode = () => getToolMode() === "select";

  const isMoveMode = () => getToolMode() === "move";

  const isRotateMode = () => getToolMode() === "rotate";

  const isMeasureMode = () => getToolMode() === "measure";

  const fixtureUids = createMemo(() => fixtures().map((entry) => entry.uid));

  const sceneObjectUids = createMemo(() =>
    sceneObjects().map((entry) => entry.uid),
  );

  /** Fixture UIDs with values currently present in the programmer. */
  const programmerValueUids = createMemo(() =>
    Array.from(new Set($programmerState().map((row) => row.fixtureUid))),
  );

  /** Selection shared by visualizer affordances and object transform workflows. */
  const selectedVisualizerUids = createMemo(() =>
    combineVisualizerSelectionUids(
      $programmerSelection(),
      $visualizerSceneObjectSelection(),
    ),
  );

  /** Applies a visualizer pick to backend fixture selection plus local object selection. */
  const dispatchVisualizerSelectionCommand = (
    uids: readonly string[],
    modifiers: { shiftKey: boolean; ctrlOrMetaKey: boolean },
  ) => {
    const fixtureUidSet = new Set(fixtureUids());
    const sceneObjectUidSet = new Set(sceneObjectUids());
    const fixtureSelection = uids.filter((uid) => fixtureUidSet.has(uid));
    const sceneObjectSelection = uids.filter((uid) =>
      sceneObjectUidSet.has(uid),
    );
    const nextSceneObjectSelection = applyVisualizerSelectionModifiers(
      $visualizerSceneObjectSelection(),
      sceneObjectUids(),
      sceneObjectSelection,
      modifiers,
    );

    if (
      !orderedUidListsEqual(
        $visualizerSceneObjectSelection(),
        nextSceneObjectSelection,
      )
    ) {
      setStoreAction(
        visualizerSceneObjectSelection,
        "Update Visualizer Scene Selection",
        nextSceneObjectSelection,
      );
    }

    context.dispatchProgrammerSelectionCommand(fixtureSelection, modifiers);
  };

  const { renderer } = useVisualizerRendererLifecycle({
    canvasRef: () => canvasRef,
    containerRef: () => containerRef,
    forceMainThread: props.forceMainThread,
    getToolMode,
    getSelection: $programmerSelection,
    onStats: (stats) =>
      setStoreAction(visualizerStats, "Update Visualizer Stats", stats),
    apiRef: props.apiRef,
  });

  const getCanvasScreenPoint = (
    event: PointerEvent,
  ): VisualizerScreenPoint | null => {
    if (!canvasRef) return null;
    const rect = canvasRef.getBoundingClientRect();
    const viewportWidth = canvasRef.clientWidth || 1;
    const viewportHeight = canvasRef.clientHeight || 1;
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      viewportWidth,
      viewportHeight,
    };
  };

  const selectionInteraction = useSelectionToolInteraction({
    canvasRef: () => canvasRef,
    renderer,
    getCanvasScreenPoint,
    dispatchProgrammerSelectionCommand: (
      uids: readonly string[],
      modifiers: { shiftKey: boolean; ctrlOrMetaKey: boolean },
    ) => {
      dispatchVisualizerSelectionCommand(uids, modifiers);
    },
  });
  const selectionOverlayStyle = selectionInteraction.selectionOverlayStyle;

  const moveInteraction = useMoveToolInteraction({
    canvasRef: () => canvasRef,
    renderer,
    transformables: () => [
      ...fixtures().map((entry) => ({
        uid: entry.uid,
        kind: "fixture" as const,
        position: entry.position,
      })),
      ...sceneObjects().map((entry) => ({
        uid: entry.uid,
        kind: "sceneObject" as const,
        position: entry.position,
      })),
    ],
    selectedUids: selectedVisualizerUids,
    isMoveMode,
    getCanvasScreenPoint,
    setAxisOverlay,
    dispatchProgrammerSelectionCommand: (
      uids: readonly string[],
      modifiers: { shiftKey: boolean; ctrlOrMetaKey: boolean },
    ) => {
      dispatchVisualizerSelectionCommand(uids, modifiers);
    },
    onCommitMove: (positions) => {
      const fixtureMap = $fixturesStore();
      const sceneObjectMap = $sceneObjectsStore();
      const batchId = crypto.randomUUID().replace(/-/g, "");
      const fixtureUpdates: types.FixturePlacementUpdateEntry[] = [];
      for (const { uid, kind, position } of positions) {
        if (kind === "fixture") {
          const fixture = fixtureMap[uid];
          if (!fixture) continue;
          fixtureUpdates.push({
            id: fixture.identifiers.id,
            position: {
              type: "All",
              data: {
                x: position.x,
                y: position.y,
                z: position.z,
              },
            },
          });
          continue;
        }

        const sceneObject = sceneObjectMap[uid];
        if (!sceneObject) continue;
        applySceneObjectPlacementPreviewUpdate(uid, (placement) => {
          placement.position = {
            x: position.x,
            y: position.y,
            z: position.z,
          };
        });
        updateSceneObjectPlacement(
          sceneObject.identifiers.id,
          {
            type: "All",
            data: {
              x: position.x,
              y: position.y,
              z: position.z,
            },
          },
          undefined,
          batchId,
        );
      }
      if (fixtureUpdates.length > 0) {
        sendFixturePlacementUpdates(fixtureUpdates, batchId);
      }
    },
  });

  const measureInteraction = useMeasureToolInteraction({
    canvasRef: () => canvasRef,
    renderer,
    fixtures,
    isMeasureMode,
    getCanvasScreenPoint,
    setAxisOverlay,
  });

  const rotateInteraction = useRotateToolInteraction({
    canvasRef: () => canvasRef,
    renderer,
    transformables: () => [
      ...fixtures().map((entry) => ({
        uid: entry.uid,
        kind: "fixture" as const,
        position: entry.position,
        rotation: entry.rotation,
      })),
      ...sceneObjects().map((entry) => ({
        uid: entry.uid,
        kind: "sceneObject" as const,
        position: entry.position,
        rotation: entry.rotation,
      })),
    ],
    selectedUids: selectedVisualizerUids,
    isRotateMode,
    getCanvasScreenPoint,
    setAxisOverlay,
    dispatchProgrammerSelectionCommand: (
      uids: readonly string[],
      modifiers: { shiftKey: boolean; ctrlOrMetaKey: boolean },
    ) => {
      dispatchVisualizerSelectionCommand(uids, modifiers);
    },
    onCommitRotate: (rotations) => {
      const fixtureMap = $fixturesStore();
      const sceneObjectMap = $sceneObjectsStore();
      const batchId = crypto.randomUUID().replace(/-/g, "");
      const fixtureUpdates: types.FixturePlacementUpdateEntry[] = [];
      for (const { uid, kind, rotation } of rotations) {
        if (kind === "fixture") {
          const fixture = fixtureMap[uid];
          if (!fixture) continue;
          fixtureUpdates.push({
            id: fixture.identifiers.id,
            rotation: {
              type: "All",
              data: {
                x: rotation.x,
                y: rotation.y,
                z: rotation.z,
              },
            },
          });
          continue;
        }

        const sceneObject = sceneObjectMap[uid];
        if (!sceneObject) continue;
        applySceneObjectPlacementPreviewUpdate(uid, (placement) => {
          placement.rotation = {
            x: rotation.x,
            y: rotation.y,
            z: rotation.z,
          };
        });
        updateSceneObjectPlacement(
          sceneObject.identifiers.id,
          undefined,
          {
            type: "All",
            data: {
              x: rotation.x,
              y: rotation.y,
              z: rotation.z,
            },
          },
          batchId,
        );
      }
      if (fixtureUpdates.length > 0) {
        sendFixturePlacementUpdates(fixtureUpdates, batchId);
      }
    },
  });

  const cancelActiveToolOperation = () => {
    const moveActive = moveInteraction.isOperationActive();
    const rotateActive = rotateInteraction.isOperationActive();
    const measureActive = measureInteraction.isOperationActive();
    let didCancel = false;
    if (moveActive) {
      didCancel = moveInteraction.cancelMoveOperation() || didCancel;
    }
    if (rotateActive) {
      didCancel = rotateInteraction.cancelRotateOperation() || didCancel;
    }
    if (measureActive) {
      didCancel = measureInteraction.cancelMeasureOperation() || didCancel;
    }
    return moveActive || rotateActive || measureActive || didCancel;
  };

  const measureLineStyle = createMemo(() => {
    const overlay = measureInteraction.measureOverlay();
    if (!overlay) return undefined;
    const dx = overlay.endX - overlay.startX;
    const dy = overlay.endY - overlay.startY;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length < 1) return undefined;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    return {
      position: "absolute",
      left: `${overlay.startX}px`,
      top: `${overlay.startY}px`,
      width: `${length}px`,
      height: "2px",
      background: MINI_AXIS_COLORS[overlay.axis],
      transform: `rotate(${angle}deg)`,
      "transform-origin": "0 50%",
      "pointer-events": "none",
      "z-index": 15,
    } as const;
  });

  const measureLabelStyle = createMemo(() => {
    const overlay = measureInteraction.measureOverlay();
    if (!overlay) return undefined;
    const midX = (overlay.startX + overlay.endX) / 2;
    const midY = (overlay.startY + overlay.endY) / 2;
    return {
      position: "absolute",
      left: `${midX}px`,
      top: `${midY - 24}px`,
      transform: "translate(-50%, -50%)",
      padding: "2px 6px",
      background: "rgba(0, 0, 0, 0.75)",
      color: "#34d399",
      "font-family": "monospace",
      "font-size": "12px",
      "border-radius": "3px",
      border: "1px solid rgba(16, 185, 129, 0.8)",
      "pointer-events": "none",
      "z-index": 16,
    } as const;
  });

  const measureStartPointStyle = createMemo(() => {
    const overlay = measureInteraction.measureOverlay();
    if (!overlay) return undefined;
    return {
      position: "absolute",
      left: `${overlay.startX - 4}px`,
      top: `${overlay.startY - 4}px`,
      width: "8px",
      height: "8px",
      background: "rgba(52, 211, 153, 0.95)",
      border: "1px solid rgba(255, 255, 255, 0.9)",
      "border-radius": "2px",
      "pointer-events": "none",
      "z-index": 16,
    } as const;
  });

  const measureEndPointStyle = createMemo(() => {
    const overlay = measureInteraction.measureOverlay();
    if (!overlay) return undefined;
    return {
      position: "absolute",
      left: `${overlay.endX - 4}px`,
      top: `${overlay.endY - 4}px`,
      width: "8px",
      height: "8px",
      background: "rgba(52, 211, 153, 0.95)",
      border: "1px solid rgba(255, 255, 255, 0.9)",
      "border-radius": "2px",
      "pointer-events": "none",
      "z-index": 16,
    } as const;
  });

  const moveOriginMarkerStyle = (marker: { x: number; y: number }) =>
    ({
      position: "absolute",
      left: `${marker.x - 5}px`,
      top: `${marker.y - 5}px`,
      width: "10px",
      height: "10px",
      background: "#00ff00",
      border: "1px solid rgba(0, 0, 0, 0.35)",
      "border-radius": "999px",
      "box-shadow": "0 0 10px rgba(0, 255, 0, 0.7)",
      "pointer-events": "none",
      "z-index": 14,
    }) as const;

  const moveTranslateLineStyle = createMemo(() => {
    const overlay = moveInteraction.moveTranslateOverlay();
    if (!overlay) return undefined;
    const dx = overlay.endX - overlay.startX;
    const dy = overlay.endY - overlay.startY;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length < 1) return undefined;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    return {
      position: "absolute",
      left: `${overlay.startX}px`,
      top: `${overlay.startY}px`,
      width: `${length}px`,
      height: "2px",
      background: MINI_AXIS_COLORS[overlay.axis],
      transform: `rotate(${angle}deg)`,
      "transform-origin": "0 50%",
      "pointer-events": "none",
      "z-index": 15,
    } as const;
  });

  const moveTranslateLabelStyle = createMemo(() => {
    const overlay = moveInteraction.moveTranslateOverlay();
    if (!overlay) return undefined;
    const midX = (overlay.startX + overlay.endX) / 2;
    const midY = (overlay.startY + overlay.endY) / 2;
    return {
      position: "absolute",
      left: `${midX}px`,
      top: `${midY - 24}px`,
      transform: "translate(-50%, -50%)",
      padding: "2px 6px",
      background: "rgba(0, 0, 0, 0.75)",
      color: MINI_AXIS_COLORS[overlay.axis],
      "font-family": "monospace",
      "font-size": "12px",
      "border-radius": "3px",
      border: `1px solid ${MINI_AXIS_COLORS[overlay.axis]}`,
      "pointer-events": "none",
      "z-index": 16,
    } as const;
  });

  const rotateLabelStyle = (overlay: {
    x: number;
    y: number;
    axis: Axis;
    isActive: boolean;
  }) => {
    return {
      position: "absolute",
      left: `${overlay.x}px`,
      top: `${overlay.y - 24}px`,
      transform: "translate(-50%, -50%)",
      padding: "2px 6px",
      background: "rgba(0, 0, 0, 0.75)",
      color: MINI_AXIS_COLORS[overlay.axis],
      "font-family": "monospace",
      "font-size": overlay.isActive ? "12px" : "11px",
      "font-weight": overlay.isActive ? "700" : "500",
      "border-radius": "3px",
      border: `1px solid ${MINI_AXIS_COLORS[overlay.axis]}`,
      opacity: overlay.isActive ? 1 : 0.78,
      "pointer-events": "none",
      "z-index": 16,
    } as const;
  };

  const rotateDotStyle = (overlay: {
    dotX: number;
    dotY: number;
    axis: Axis;
    isActive: boolean;
  }) => {
    return {
      position: "absolute",
      left: `${overlay.dotX - 4}px`,
      top: `${overlay.dotY - 4}px`,
      width: "8px",
      height: "8px",
      background: MINI_AXIS_COLORS[overlay.axis],
      border: "1px solid rgba(255, 255, 255, 0.95)",
      "border-radius": "999px",
      "box-shadow": "0 0 10px rgba(0, 0, 0, 0.5)",
      opacity: overlay.isActive ? 1 : 0.75,
      "pointer-events": "none",
      "z-index": 16,
    } as const;
  };

  const rotateGizmoPolylines = createMemo(() => {
    const overlay = rotateInteraction.rotateGizmoOverlay();
    if (!overlay) return null;

    const toPolyline = (points: readonly { x: number; y: number }[]) => {
      if (points.length < 2) return "";
      return points.map((point) => `${point.x},${point.y}`).join(" ");
    };
    const toPolylines = (
      polylines: readonly ReadonlyArray<{ x: number; y: number }>[],
    ) => {
      return polylines.map((points) => toPolyline(points)).filter(Boolean);
    };
    return {
      activeAxis: overlay.activeAxis,
      rings: {
        x: {
          front: toPolylines(overlay.rings.x.front),
          back: toPolylines(overlay.rings.x.back),
        },
        y: {
          front: toPolylines(overlay.rings.y.front),
          back: toPolylines(overlay.rings.y.back),
        },
        z: {
          front: toPolylines(overlay.rings.z.front),
          back: toPolylines(overlay.rings.z.back),
        },
      },
    };
  });

  const rotateOriginMarkers = createMemo(() => {
    const markers = rotateInteraction.rotateOriginOverlay();
    const gizmo = rotateInteraction.rotateGizmoOverlay();
    if (!markers || !gizmo) return null;
    return markers;
  });

  // Keyboard shortcuts
  const COMPONENT_ID = context.panelId;
  useKeyboardShortcut({
    key: "c",
    handler: () => context.setToolMode("camera"),
    description: "Switch to camera tool",
    componentId: COMPONENT_ID,
  });

  useKeyboardShortcut({
    key: "Shift+m",
    handler: () => context.setToolMode("measure"),
    description: "Switch to measure tool",
    componentId: COMPONENT_ID,
  });

  useKeyboardShortcut({
    key: "m",
    handler: () => context.setToolMode("move"),
    description: "Switch to move tool",
    componentId: COMPONENT_ID,
  });

  useKeyboardShortcut({
    key: "t",
    handler: () => context.setToolMode("rotate"),
    description: "Switch to rotate tool",
    componentId: COMPONENT_ID,
  });

  useKeyboardShortcut({
    key: "s",
    handler: () => context.setToolMode("select"),
    description: "Switch to select tool",
    componentId: COMPONENT_ID,
  });

  useKeyboardShortcut({
    key: "e",
    handler: () => context.setShowEmitters(!context.showEmitters()),
    description: "Toggle emitter debug markers",
    componentId: COMPONENT_ID,
  });

  useKeyboardShortcut({
    key: "g",
    handler: () => context.setShowGrid(!context.showGrid()),
    description: "Toggle grid visibility",
    componentId: COMPONENT_ID,
  });

  useKeyboardShortcut({
    key: "b",
    handler: () => renderer()?.toggleBeams(),
    description: "Toggle volumetric beams",
    componentId: COMPONENT_ID,
  });

  useKeyboardShortcut({
    key: "l",
    handler: () => context.toggleShowLabels(),
    description: "Toggle fixture snap points",
    componentId: COMPONENT_ID,
  });
  useKeyboardShortcut({
    key: "f",
    handler: () => {
      const selection = programmerSelection.get();
      const selectedUids = combineVisualizerSelectionUids(
        selection,
        visualizerSceneObjectSelection.get(),
      );
      if (selectedUids.length > 0) {
        renderer()?.zoomToFit(selectedUids);
      } else {
        // If nothing selected, zoom to all fixtures
        renderer()?.zoomToFit();
      }
    },
    description: "Zoom to selection (or all fixtures)",
    componentId: COMPONENT_ID,
  });

  useKeyboardShortcut({
    key: "r",
    handler: () => renderer()?.resetCamera(),
    description: "Reset camera position",
    componentId: COMPONENT_ID,
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const moveActive = moveInteraction.isOperationActive();
    const rotateActive = rotateInteraction.isOperationActive();
    const measureActive = measureInteraction.isOperationActive();
    const toolMode = getToolMode();
    const nonCameraToolActive = toolMode !== "camera";
    if (!moveActive && !rotateActive && !measureActive && !nonCameraToolActive)
      return;

    const unregister = untrack(() =>
      registerKeyboardShortcut({
        key: "Escape",
        handler: () => {
          cancelActiveToolOperation();
          if (getToolMode() !== "camera") {
            context.setToolMode("camera");
            // Keep keyboard interaction anchored to the canvas and clear
            // focus ring left on whichever toolbar button was clicked last.
            canvasRef?.focus({ preventScroll: true });
          }
        },
        description:
          moveActive || rotateActive || measureActive
            ? "Cancel active move/rotate/measure operation or return to camera tool"
            : "Return to camera tool",
        componentId: COMPONENT_ID,
      }),
    );

    onCleanup(() => {
      untrack(() => unregister());
    });
  });

  const pointerModeHandlers = createPointerModeRouter({
    getMode: getToolMode,
    moveHandlers: moveInteraction.handlers,
    rotateHandlers: rotateInteraction.handlers,
    measureHandlers: measureInteraction.handlers,
    selectionHandlers: selectionInteraction.handlers,
  });

  /** Registers the visualizer DOM subtree for panel-local shortcut focus. */
  onMount(() => {
    if (!containerRef) return;
    const unregister = registerComponentFocus(context.panelId, containerRef);
    onCleanup(() => unregister());
  });

  /** Keeps Dockview focus aligned so panel-local shortcuts resolve to this visualizer. */
  const focusPanel = () => {
    focusTrackedComponent(context.panelId);
    $dockApi()?.getPanel(context.panelId)?.focus();
  };

  /** Moves DOM focus to the canvas after pointer entry from editable controls. */
  const focusCanvas = () => {
    focusPanel();
    const canvas = canvasRef;
    if (!canvas) return;

    const applyCanvasFocus = () => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement !== canvas) {
        activeElement.blur();
      }
      canvas.focus({ preventScroll: true });
    };

    applyCanvasFocus();
    queueMicrotask(applyCanvasFocus);
  };

  /** Selected fixture IDs. */
  const selectedFixtureIds = () => {
    const fixtureMap = $fixturesStore();
    const ids = $programmerSelection()
      .map((uid) => fixtureMap[uid]?.identifiers.id)
      .filter((id): id is number => id !== undefined);
    return Array.from(new Set(ids));
  };

  /** Selected scene object IDs. */
  const selectedSceneObjectIds = () => {
    const objectMap = $sceneObjectsStore();
    const ids = $visualizerSceneObjectSelection()
      .map((uid) => objectMap[uid]?.identifiers.id)
      .filter((id): id is number => id !== undefined);
    return Array.from(new Set(ids));
  };

  const selectedDeleteCount = () =>
    selectedFixtureIds().length + selectedSceneObjectIds().length;

  const deleteConfirmMessage = () => {
    const fixtureCount = selectedFixtureIds().length;
    const sceneObjectCount = selectedSceneObjectIds().length;
    const parts: string[] = [];
    if (fixtureCount > 0) {
      parts.push(`${fixtureCount} fixtures`);
    }
    if (sceneObjectCount > 0) {
      parts.push(`${sceneObjectCount} scene objects`);
    }
    return `Delete ${parts.join(" and ")}? This can be undone in one step.`;
  };

  const confirmDeleteSelection = () => {
    const fixtureIds = selectedFixtureIds();
    const sceneObjectIds = selectedSceneObjectIds();
    const batchId = crypto.randomUUID();

    context.sendProgrammerCommand(
      { type: "ClearProgrammerSelection" },
      batchId,
    );
    setStoreAction(
      visualizerSceneObjectSelection,
      "Clear Visualizer Scene Selection",
      [],
    );

    if (fixtureIds.length > 0) {
      removePatchBindingsForFixtureIds(
        fixtureIds,
        $bindings(),
        $fixturesStore(),
        batchId,
      );
      for (const fixtureId of fixtureIds) {
        sendDeleteFixture(fixtureId, batchId);
      }
    }

    for (const sceneObjectId of sceneObjectIds) {
      deleteSceneObject(sceneObjectId, batchId);
    }
    setIsDeleteModalOpen(false);
  };

  /** Momentarily disables camera drag to clear any latched pointer state. */
  const resetCameraPointerDrag = () =>
    resetCameraPointerDragForRenderer(renderer);

  /** Opens the fixture wizard from the visualizer context menu. */
  const openFixtureWizardFromContextMenu = () => {
    resetCameraPointerDrag();
    openFixtureWizard();
  };

  /** Opens the object wizard from the visualizer context menu. */
  const openObjectWizardFromContextMenu = () => {
    resetCameraPointerDrag();
    openObjectWizard();
  };

  const openVisualizerContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    focusCanvas();
    resetCameraPointerDrag();

    const currentToolMode = context.toolMode();
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          id: "delete-visualizer-selection",
          label:
            selectedDeleteCount() > 0
              ? `Delete Selected (${selectedDeleteCount()})`
              : "Delete Selected",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          disabled: selectedDeleteCount() === 0,
          onSelect: () => setIsDeleteModalOpen(true),
        },
        {
          id: "clear-visualizer-selection",
          label: "Clear Selection",
          icon: EraserIcon,
          disabled: selectedVisualizerUids().length === 0,
          onSelect: () => {
            context.sendProgrammerCommand({
              type: "ClearProgrammerSelection",
            });
            setStoreAction(
              visualizerSceneObjectSelection,
              "Clear Visualizer Scene Selection",
              [],
            );
          },
        },
        { id: "visualizer-selection-separator", type: "separator" },
        {
          id: "add-fixture",
          label: "New Fixture",
          icon: LightbulbIcon,
          onSelect: openFixtureWizardFromContextMenu,
        },
        {
          id: "add-object",
          label: "New Object",
          icon: CubeIcon,
          onSelect: openObjectWizardFromContextMenu,
        },
        { id: "visualizer-add-separator", type: "separator" },
        ...(["camera", "select", "move", "rotate", "measure"] as const).map(
          (mode) => ({
            id: `tool-${mode}`,
            label: `${mode[0].toUpperCase()}${mode.slice(1)} Tool`,
            checked: currentToolMode === mode,
            onSelect: () => context.setToolMode(mode),
          }),
        ),
      ],
    });
  };

  useVisualizerRendererSync({
    renderer,
    fixtures,
    sceneObjects,
    selectedUids: selectedVisualizerUids,
    editSelectionUids: $visualizerEditSelection,
    programmerValueUids,
    activeSelectionTargets: $activeSelectionSpanTargets,
    highlightSelectionEnabled: $highlightSelection,
    showEmitters: context.showEmitters,
    showGrid: context.showGrid,
    showOrbitTargetIndicator: $showOrbitTargetIndicator,
    showLabels: context.showLabels,
    toolMode: context.toolMode,
    rotationMode: $rotationMode,
  });

  createEffect(() => {
    if (!isSelectionMode()) {
      selectionInteraction.clearSelectionDrag();
    }
  });

  createEffect(() => {
    if (isMoveMode()) return;
    moveInteraction.cancelMoveOperation();
  });

  createEffect(() => {
    if (isRotateMode()) return;
    rotateInteraction.cancelRotateOperation();
  });

  createEffect(() => {
    if (isMeasureMode()) return;
    measureInteraction.cancelMeasureOperation();
  });

  onCleanup(() => {
    log.trace("unmounting");
    selectionInteraction.clearSelectionDrag();
    moveInteraction.cancelMoveOperation();
    rotateInteraction.cancelRotateOperation();
    measureInteraction.cancelMeasureOperation();
  });

  return (
    <div
      ref={containerRef}
      class={props.class}
      style={{ position: "relative" }}
    >
      <canvas
        ref={canvasRef}
        aria-label="3D visualizer viewport"
        role="img"
        tabindex="0"
        style={{ display: "block", width: "100%", height: "100%" }}
        onPointerDown={(event) => {
          pointerModeHandlers.onPointerDown(event);
          focusCanvas();
        }}
        onClick={() => focusCanvas()}
        onPointerMove={pointerModeHandlers.onPointerMove}
        onPointerUp={pointerModeHandlers.onPointerUp}
        onPointerCancel={pointerModeHandlers.onPointerCancel}
        onContextMenu={openVisualizerContextMenu}
      />
      <DeleteConfirmModal
        isOpen={isDeleteModalOpen()}
        title="Delete selected visualizer objects"
        message={deleteConfirmMessage()}
        confirmLabel="Delete"
        onCancel={() => setIsDeleteModalOpen(false)}
        onConfirm={confirmDeleteSelection}
      />
      <Show when={selectionOverlayStyle()}>
        {(style) => <div style={style()} />}
      </Show>
      <Show when={measureLineStyle()}>
        {(style) => <div style={style()} />}
      </Show>
      <Show when={measureStartPointStyle()}>
        {(style) => <div style={style()} />}
      </Show>
      <Show when={measureEndPointStyle()}>
        {(style) => <div style={style()} />}
      </Show>
      <Show when={measureLabelStyle()}>
        {(style) => (
          <div style={style()}>
            {measureInteraction.measureOverlay()?.label}
          </div>
        )}
      </Show>
      <Show when={moveInteraction.moveOriginOverlay()}>
        {(markers) => (
          <For each={markers()}>
            {(marker) => <div style={moveOriginMarkerStyle(marker)} />}
          </For>
        )}
      </Show>
      <Show when={moveTranslateLineStyle()}>
        {(style) => <div style={style()} />}
      </Show>
      <Show when={moveTranslateLabelStyle()}>
        {(style) => (
          <div style={style()}>
            {moveInteraction.moveTranslateOverlay()?.label}
          </div>
        )}
      </Show>
      <Show when={rotateOriginMarkers()}>
        {(markers) => (
          <For each={markers()}>
            {(marker) => <div style={moveOriginMarkerStyle(marker)} />}
          </For>
        )}
      </Show>
      <Show when={rotateGizmoPolylines()}>
        {(overlay) => (
          <svg
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: "100%",
              height: "100%",
              "pointer-events": "none",
              "z-index": 14,
            }}
          >
            <For each={["x", "y", "z"] as const}>
              {(axis) => {
                const ringBack = () => overlay().rings[axis].back;

                const ringFront = () => overlay().rings[axis].front;

                const isActive = () => overlay().activeAxis === axis;
                return (
                  <>
                    <For each={ringBack()}>
                      {(points) => (
                        <polyline
                          points={points}
                          fill="none"
                          stroke={MINI_AXIS_COLORS[axis]}
                          stroke-width={isActive() ? 3.5 : 2}
                          stroke-opacity={isActive() ? 0.45 : 0.28}
                          stroke-dasharray={isActive() ? "6 6" : "5 6"}
                          stroke-linecap="round"
                          vector-effect="non-scaling-stroke"
                        />
                      )}
                    </For>
                    <For each={ringFront()}>
                      {(points) => (
                        <polyline
                          points={points}
                          fill="none"
                          stroke={MINI_AXIS_COLORS[axis]}
                          stroke-width={isActive() ? 3.5 : 2}
                          stroke-opacity={isActive() ? 0.95 : 0.7}
                          stroke-linecap="round"
                          vector-effect="non-scaling-stroke"
                        />
                      )}
                    </For>
                  </>
                );
              }}
            </For>
          </svg>
        )}
      </Show>
      <Show when={rotateInteraction.rotateAngleOverlay()}>
        {(overlays) => (
          <For each={overlays()}>
            {(overlay) => (
              <>
                <div style={rotateLabelStyle(overlay)}>{overlay.label}</div>
                <div style={rotateDotStyle(overlay)} />
              </>
            )}
          </For>
        )}
      </Show>
      <Show when={$visualizerStats()}>
        <div
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            padding: "4px 8px",
            background: "rgba(0, 0, 0, 0.6)",
            color:
              $visualizerStats()!.fps >= 57
                ? "#0f0"
                : $visualizerStats()!.fps >= 48
                  ? "#ff0"
                  : "#f00",
            "font-family": "monospace",
            "font-size": "14px",
            "border-radius": "4px",
            "pointer-events": "none",
          }}
        >
          <span class="fps-label">
            {Math.round($visualizerStats()!.fps)} FPS
          </span>
        </div>
      </Show>
    </div>
  );
};
