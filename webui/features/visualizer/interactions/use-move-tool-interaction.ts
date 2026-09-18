// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Move-tool interaction hook for Visualizer.
 *
 * Coordinates pointer gestures, axis-lock overlays, and preview positioning via
 * `VisualizerMoveController`, then commits final fixture positions on drag end.
 */

import { createSignal } from "solid-js";
import { VisualizerMoveController } from "../controllers/visualizer-move-controller";
import type {
  CameraState,
  IVisualizerRenderer,
  Vec3,
  VisualizerScreenPoint,
} from "../rendering/renderers/renderer-api";
import type { VisualizerPointerHandlers } from "./use-visualizer-pointer-mode-router";
import { projectWorldPointToScreen } from "./visualizer-interaction-math";
import type { Axis } from "./visualizer-interaction-types";
import {
  clearToolPointerState,
  createIdleToolPointerState,
  getPointerTrackingState,
  isToolOperationActive,
  resolvePointerUp,
  startToolDrag,
  updateDragDidMoveFromSlop,
} from "./visualizer-tool-interaction-state";

const MOVE_CLICK_SLOP_PX = 4;

interface SelectionModifiers {
  shiftKey: boolean;
  ctrlOrMetaKey: boolean;
}

interface AxisOverlay {
  centerX: number;
  centerY: number;
  lockedAxis: Axis | null;
}

type MoveTransformableKind = "fixture" | "sceneObject";

interface MoveTransformable {
  uid: string;
  kind: MoveTransformableKind;
  position: Vec3;
}

/** Formats the move overlay with both delta distance and resulting absolute value. */
export function formatMoveTranslateOverlayLabel(
  axis: Axis,
  distance: number,
  absoluteValue: number,
): string {
  return `${axis.toUpperCase()}: ${distance.toFixed(2)}m -> ${absoluteValue.toFixed(2)}m`;
}

interface UseMoveToolInteractionOptions {
  canvasRef: () => HTMLCanvasElement | undefined;
  renderer: () => IVisualizerRenderer | null;
  transformables: () => readonly MoveTransformable[];
  selectedUids: () => readonly string[];
  isMoveMode: () => boolean;
  getCanvasScreenPoint: (event: PointerEvent) => VisualizerScreenPoint | null;
  setAxisOverlay: (overlay: AxisOverlay | null) => void;
  dispatchProgrammerSelectionCommand: (
    uids: readonly string[],
    modifiers: SelectionModifiers,
  ) => void;
  onCommitMove: (
    positions: Array<{
      uid: string;
      kind: MoveTransformableKind;
      position: Vec3;
    }>,
  ) => void;
}

/**
 * Creates move-mode pointer handlers plus move-origin and translation overlays.
 */
export function useMoveToolInteraction(options: UseMoveToolInteractionOptions) {
  const moveController = new VisualizerMoveController();
  const [moveOriginState, setMoveOriginState] = createSignal<{
    cameraState: CameraState;
    startPositions: Array<{ uid: string; position: Vec3 }>;
  } | null>(null);
  const [moveOriginOverlay, setMoveOriginOverlay] = createSignal<Array<{
    uid: string;
    x: number;
    y: number;
  }> | null>(null);
  const [moveTranslateReferenceUid, setMoveTranslateReferenceUid] =
    createSignal<string | null>(null);
  const [moveTranslateOverlay, setMoveTranslateOverlay] = createSignal<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    label: string;
    axis: Axis;
  } | null>(null);
  const [moveToolPointerState, setMoveToolPointerState] = createSignal(
    createIdleToolPointerState(),
  );

  const clearMoveOriginOverlay = () => {
    setMoveOriginState(null);
    setMoveOriginOverlay(null);
  };

  const clearMoveTranslateOverlay = () => {
    setMoveTranslateReferenceUid(null);
    setMoveTranslateOverlay(null);
  };

  const applyMovePreviewPositions = (
    r: IVisualizerRenderer,
    positions: Array<{ uid: string; position: Vec3 }>,
  ) => {
    const transformableMap = new Map(
      options.transformables().map((entry) => [entry.uid, entry]),
    );
    for (const { uid, position } of positions) {
      const target = transformableMap.get(uid);
      if (!target) continue;
      if (target.kind === "fixture") {
        r.setFixturePosition(uid, position);
      } else {
        r.setSceneObjectPosition(uid, position);
      }
    }
  };

  const withMoveKinds = (positions: Array<{ uid: string; position: Vec3 }>) => {
    const transformableMap = new Map(
      options.transformables().map((entry) => [entry.uid, entry]),
    );
    return positions
      .map((entry) => {
        const target = transformableMap.get(entry.uid);
        if (!target) return null;
        return { ...entry, kind: target.kind };
      })
      .filter(
        (
          entry,
        ): entry is {
          uid: string;
          kind: MoveTransformableKind;
          position: Vec3;
        } => entry !== null,
      );
  };

  const updateMoveOriginOverlay = (
    viewportWidth: number,
    viewportHeight: number,
  ) => {
    const overlayState = moveOriginState();
    if (!overlayState) {
      setMoveOriginOverlay(null);
      return;
    }

    const projected = overlayState.startPositions
      .map((entry) => {
        const screen = projectWorldPointToScreen(
          entry.position,
          overlayState.cameraState,
          viewportWidth,
          viewportHeight,
        );
        if (!screen) return null;
        return { uid: entry.uid, x: screen.x, y: screen.y };
      })
      .filter(
        (entry): entry is { uid: string; x: number; y: number } =>
          entry !== null,
      );

    setMoveOriginOverlay(projected.length > 0 ? projected : null);
  };

  const commitMoveDrag = () => {
    const r = options.renderer();
    const commit = moveController.endDrag();
    if (!commit) return;

    if (r) {
      applyMovePreviewPositions(r, commit.positions);
    }

    if (commit.didMove) {
      options.onCommitMove(withMoveKinds(commit.positions));
    }
  };

  const setMoveCameraDragSuppressed = (suppressed: boolean) => {
    options.renderer()?.setCameraDragEnabled(!suppressed);
  };

  const cancelMoveOperation = () => {
    setMoveCameraDragSuppressed(false);
    const pointerState = moveToolPointerState();
    const activePointerId = pointerState.dragPointerId;
    const { hadOperation, nextState } = clearToolPointerState(pointerState);

    const canvas = options.canvasRef();
    if (
      activePointerId !== null &&
      canvas?.hasPointerCapture(activePointerId)
    ) {
      canvas.releasePointerCapture(activePointerId);
    }

    options.setAxisOverlay(null);
    clearMoveOriginOverlay();
    clearMoveTranslateOverlay();

    const r = options.renderer();
    const preview = moveController.cancelDrag();
    if (r && preview) {
      applyMovePreviewPositions(r, preview.positions);
    }

    if (hadOperation || preview !== null) {
      setMoveToolPointerState(nextState);
    }

    return hadOperation || preview !== null;
  };

  const tryCapturePointer = (pointerId: number): boolean => {
    const canvas = options.canvasRef();
    if (!canvas) return false;
    try {
      canvas.setPointerCapture(pointerId);
      return true;
    } catch {
      return false;
    }
  };

  /** Release the pointer capture if held. */
  const releasePointerCaptureIfHeld = (pointerId: number) => {
    const canvas = options.canvasRef();
    if (canvas?.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  };

  const canContinueMovePointerDown = (): boolean => {
    if (!options.isMoveMode()) return false;
    return !isToolOperationActive(moveToolPointerState());
  };

  const handlers: VisualizerPointerHandlers = {
    onPointerDown: async (event) => {
      if (event.button !== 0) return;
      if (!options.canvasRef()) return;

      if (moveToolPointerState().clickLockActive) {
        setMoveCameraDragSuppressed(false);
        commitMoveDrag();
        options.setAxisOverlay(null);
        clearMoveOriginOverlay();
        clearMoveTranslateOverlay();
        setMoveToolPointerState(createIdleToolPointerState());
        event.preventDefault();
        return;
      }

      const r = options.renderer();
      const point = options.getCanvasScreenPoint(event);
      if (!r || !point) return;

      let dragStarted = false;
      try {
        let hitUid = await r.pickFixtureAtScreenPoint(point);
        if (!canContinueMovePointerDown()) return;
        if (!hitUid) {
          hitUid = await r.pickSceneObjectAtScreenPoint(point);
          if (!canContinueMovePointerDown()) return;
        }
        if (!hitUid) return;
        if (!tryCapturePointer(event.pointerId)) return;
        if (!canContinueMovePointerDown()) return;

        const cameraState = await r.getCameraState();
        if (!canContinueMovePointerDown()) return;
        const beginResult = moveController.beginDrag({
          pointerId: event.pointerId,
          hitFixtureUid: hitUid,
          point,
          cameraState,
          selectedUids: options.selectedUids(),
          fixtures: options
            .transformables()
            .map((entry) => ({ uid: entry.uid, position: entry.position })),
        });
        if (!beginResult) return;

        const hitTransformable = options
          .transformables()
          .find((entry) => entry.uid === hitUid);
        if (beginResult.setSelectionToHitFixture && hitTransformable) {
          options.dispatchProgrammerSelectionCommand([hitUid], {
            shiftKey: false,
            ctrlOrMetaKey: false,
          });
        }

        setMoveOriginState({
          cameraState,
          startPositions: beginResult.startPositions,
        });
        setMoveCameraDragSuppressed(true);
        setMoveToolPointerState(startToolDrag(event.pointerId, point));
        clearMoveTranslateOverlay();
        setMoveTranslateReferenceUid(hitUid);
        updateMoveOriginOverlay(point.viewportWidth, point.viewportHeight);
        options.setAxisOverlay({
          centerX: point.x,
          centerY: point.y,
          lockedAxis: null,
        });
        dragStarted = true;
        event.preventDefault();
      } finally {
        if (!dragStarted) {
          releasePointerCaptureIfHeld(event.pointerId);
        }
      }
    },
    onPointerMove: (event) => {
      const point = options.getCanvasScreenPoint(event);
      if (!point) return;
      let pointerState = moveToolPointerState();
      const trackingState = getPointerTrackingState(
        pointerState,
        event.pointerId,
      );
      if (!trackingState.isTracking) return;

      if (trackingState.isActiveDragPointer) {
        const nextPointerState = updateDragDidMoveFromSlop(
          pointerState,
          point,
          MOVE_CLICK_SLOP_PX,
        );
        if (nextPointerState !== pointerState) {
          pointerState = nextPointerState;
          setMoveToolPointerState(nextPointerState);
        }
      }

      const r = options.renderer();
      if (!r) return;

      const preview = moveController.updateDrag(point, event.shiftKey);
      if (!preview) return;

      updateMoveOriginOverlay(point.viewportWidth, point.viewportHeight);
      options.setAxisOverlay({
        centerX: point.x,
        centerY: point.y,
        lockedAxis: preview.lockedAxis,
      });

      const overlayState = moveOriginState();
      const referenceUid = moveTranslateReferenceUid();
      if (
        !overlayState ||
        !preview.lockedAxis ||
        preview.distance <= 0 ||
        preview.positions.length === 0
      ) {
        setMoveTranslateOverlay(null);
      } else {
        const startEntry = referenceUid
          ? overlayState.startPositions.find(
              (entry) => entry.uid === referenceUid,
            )
          : overlayState.startPositions[0];
        const endEntry = referenceUid
          ? preview.positions.find((entry) => entry.uid === referenceUid)
          : preview.positions[0];

        if (!startEntry || !endEntry) {
          setMoveTranslateOverlay(null);
        } else {
          const startScreen = projectWorldPointToScreen(
            startEntry.position,
            overlayState.cameraState,
            point.viewportWidth,
            point.viewportHeight,
          );
          const endScreen = projectWorldPointToScreen(
            endEntry.position,
            overlayState.cameraState,
            point.viewportWidth,
            point.viewportHeight,
          );

          if (!startScreen || !endScreen) {
            setMoveTranslateOverlay(null);
          } else {
            setMoveTranslateOverlay({
              startX: startScreen.x,
              startY: startScreen.y,
              endX: endScreen.x,
              endY: endScreen.y,
              label: formatMoveTranslateOverlayLabel(
                preview.lockedAxis,
                preview.distance,
                endEntry.position[preview.lockedAxis],
              ),
              axis: preview.lockedAxis,
            });
          }
        }
      }

      applyMovePreviewPositions(r, preview.positions);
      event.preventDefault();
    },
    onPointerUp: (event) => {
      const resolution = resolvePointerUp(
        moveToolPointerState(),
        event.pointerId,
      );
      if (!resolution.handled) return;

      const canvas = options.canvasRef();
      if (canvas?.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      if (resolution.didMove) {
        setMoveCameraDragSuppressed(false);
        commitMoveDrag();
        options.setAxisOverlay(null);
        clearMoveOriginOverlay();
        clearMoveTranslateOverlay();
        setMoveToolPointerState(createIdleToolPointerState());
      } else {
        setMoveToolPointerState(resolution.nextState);
        setMoveCameraDragSuppressed(resolution.nextState.clickLockActive);
      }
      event.preventDefault();
    },
    onPointerCancel: (event) => {
      const dragPointerId = moveToolPointerState().dragPointerId;
      if (dragPointerId === null || event.pointerId !== dragPointerId) {
        return;
      }
      cancelMoveOperation();
    },
  };

  return {
    handlers,
    moveOriginOverlay,
    moveTranslateOverlay,
    cancelMoveOperation,
    isOperationActive: () => isToolOperationActive(moveToolPointerState()),
  };
}
