// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Rotate-tool interaction hook for Visualizer.
 *
 * Coordinates pointer gestures, axis-lock overlays, and preview rotations via
 * `VisualizerRotateController`, then commits final fixture rotations on drag end.
 */

import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  type RotateDragPreview,
  type RotateGizmoOverlay,
  VisualizerRotateController,
} from "../controllers/visualizer-rotate-controller";
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

const ROTATE_CLICK_SLOP_PX = 4;

/** Wrap an angle delta to the shortest signed degree representation. */
export function wrapSignedDegrees(angle: number): number {
  return ((((angle + 180) % 360) + 360) % 360) - 180;
}

/** Format a signed degree value for rotate overlays. */
export function formatSignedDegrees(angle: number): string {
  const normalized = Math.abs(angle) < 0.05 ? 0 : angle;
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(1)}°`;
}

/** Formats a rotate overlay with both angle delta and resulting absolute angle. */
export function formatRotateAngleOverlayLabel(
  axis: Axis,
  deltaAngle: number,
  absoluteAngle: number,
): string {
  return `${axis.toUpperCase()}: ${formatSignedDegrees(deltaAngle)} -> ${absoluteAngle.toFixed(1)}°`;
}

interface SelectionModifiers {
  shiftKey: boolean;
  ctrlOrMetaKey: boolean;
}

interface AxisOverlay {
  centerX: number;
  centerY: number;
  lockedAxis: Axis | null;
}

type RotateTransformableKind = "fixture" | "sceneObject";

interface RotateTransformable {
  uid: string;
  kind: RotateTransformableKind;
  position: Vec3;
  rotation: Vec3;
}

interface UseRotateToolInteractionOptions {
  canvasRef: () => HTMLCanvasElement | undefined;
  renderer: () => IVisualizerRenderer | null;
  transformables: () => readonly RotateTransformable[];
  selectedUids: () => readonly string[];
  isRotateMode: () => boolean;
  getCanvasScreenPoint: (event: PointerEvent) => VisualizerScreenPoint | null;
  setAxisOverlay: (overlay: AxisOverlay | null) => void;
  dispatchProgrammerSelectionCommand: (
    uids: readonly string[],
    modifiers: SelectionModifiers,
  ) => void;
  onCommitRotate: (
    rotations: Array<{
      uid: string;
      kind: RotateTransformableKind;
      rotation: Vec3;
    }>,
  ) => void;
}

/**
 * Creates rotate-mode pointer handlers plus rotate-origin and angle overlays.
 */
export function useRotateToolInteraction(
  options: UseRotateToolInteractionOptions,
) {
  const rotateController = new VisualizerRotateController();
  const [rotateOriginState, setRotateOriginState] = createSignal<{
    cameraState: CameraState;
    startPositions: Array<{ uid: string; position: Vec3 }>;
  } | null>(null);
  const [rotateOriginOverlay, setRotateOriginOverlay] = createSignal<Array<{
    uid: string;
    x: number;
    y: number;
  }> | null>(null);
  const [rotateAngleReferenceUid, setRotateAngleReferenceUid] = createSignal<
    string | null
  >(null);
  const [rotateAngleOverlay, setRotateAngleOverlay] = createSignal<
    | {
        x: number;
        y: number;
        dotX: number;
        dotY: number;
        label: string;
        axis: Axis;
        isActive: boolean;
      }[]
    | null
  >(null);
  const [rotateGizmoOverlay, setRotateGizmoOverlay] =
    createSignal<RotateGizmoOverlay | null>(null);
  const [rotateToolPointerState, setRotateToolPointerState] = createSignal(
    createIdleToolPointerState(),
  );
  const pressedPointerIds = new Set<number>();

  const clearRotateOriginOverlay = () => {
    setRotateOriginState(null);
    setRotateOriginOverlay(null);
  };

  const clearRotateAngleOverlay = () => {
    setRotateAngleReferenceUid(null);
    setRotateAngleOverlay(null);
  };

  const updateRotateAngleOverlay = (preview: RotateDragPreview | null) => {
    if (!preview || preview.rotations.length === 0) {
      setRotateAngleOverlay(null);
      return;
    }

    const referenceUid = rotateAngleReferenceUid();
    const rotationEntry = referenceUid
      ? preview.rotations.find((entry) => entry.uid === referenceUid)
      : preview.rotations[0];
    if (!rotationEntry) {
      setRotateAngleOverlay(null);
      return;
    }

    const startRotation = options
      .transformables()
      .find((entry) => entry.uid === rotationEntry.uid)?.rotation;

    const entries: Array<{
      x: number;
      y: number;
      dotX: number;
      dotY: number;
      label: string;
      axis: Axis;
      isActive: boolean;
    }> = [];

    for (const axis of ["x", "y", "z"] as const) {
      const axisAngle =
        axis === "x"
          ? rotationEntry.rotation.x
          : axis === "y"
            ? rotationEntry.rotation.y
            : rotationEntry.rotation.z;
      const startAxisAngle = startRotation
        ? axis === "x"
          ? startRotation.x
          : axis === "y"
            ? startRotation.y
            : startRotation.z
        : axisAngle;
      const deltaAngle = wrapSignedDegrees(axisAngle - startAxisAngle);
      const dot = rotateController.getRingPointForAxisAngle(axis, axisAngle);
      if (!dot) continue;
      entries.push({
        x: dot.x,
        y: dot.y,
        dotX: dot.x,
        dotY: dot.y,
        label: formatRotateAngleOverlayLabel(axis, deltaAngle, axisAngle),
        axis,
        isActive: preview.lockedAxis === axis,
      });
    }

    setRotateAngleOverlay(entries.length > 0 ? entries : null);
  };

  const clearRotateGizmoOverlay = () => {
    setRotateGizmoOverlay(null);
  };

  const resolveAxisFromRotateOverlayHit = (
    point: VisualizerScreenPoint,
  ): { axis: Axis; dotX: number; dotY: number } | null => {
    const overlays = rotateAngleOverlay();
    if (!overlays || overlays.length === 0) return null;

    let bestDotHit: {
      axis: Axis;
      dotX: number;
      dotY: number;
      distance: number;
    } | null = null;
    for (const overlay of overlays) {
      const distance = Math.hypot(
        point.x - overlay.dotX,
        point.y - overlay.dotY,
      );
      if (distance > 18) continue;
      if (!bestDotHit || distance < bestDotHit.distance) {
        bestDotHit = {
          axis: overlay.axis,
          dotX: overlay.dotX,
          dotY: overlay.dotY,
          distance,
        };
      }
    }
    if (bestDotHit) {
      return {
        axis: bestDotHit.axis,
        dotX: bestDotHit.dotX,
        dotY: bestDotHit.dotY,
      };
    }

    // Labels are centered at (x, y - 24) with translate(-50%, -50%).
    for (const overlay of overlays) {
      const labelCenterX = overlay.x;
      const labelCenterY = overlay.y - 24;
      if (
        Math.abs(point.x - labelCenterX) <= 44 &&
        Math.abs(point.y - labelCenterY) <= 14
      ) {
        return {
          axis: overlay.axis,
          dotX: overlay.dotX,
          dotY: overlay.dotY,
        };
      }
    }

    return null;
  };

  const refreshRotateOverlayState = (
    viewportWidth: number,
    viewportHeight: number,
  ) => {
    const fixtures = controllerFixtures();
    const fixtureMap = new Map(
      fixtures.map((entry) => [entry.uid, entry.position]),
    );
    const cameraState = rotateController.getSessionCameraState();
    if (cameraState) {
      const startPositions = rotateController
        .getActiveFixtureUids()
        .map((uid) => {
          const position = fixtureMap.get(uid);
          if (!position) return null;
          return { uid, position };
        })
        .filter(
          (entry): entry is { uid: string; position: Vec3 } => entry !== null,
        );
      setRotateOriginState(
        startPositions.length > 0 ? { cameraState, startPositions } : null,
      );
      updateRotateOriginOverlay(viewportWidth, viewportHeight);
    } else {
      clearRotateOriginOverlay();
    }

    const gizmoOverlay = rotateController.getGizmoOverlay();
    setRotateGizmoOverlay(gizmoOverlay);
    if (gizmoOverlay?.center) {
      options.setAxisOverlay({
        centerX: gizmoOverlay.center.x,
        centerY: gizmoOverlay.center.y,
        lockedAxis: gizmoOverlay.activeAxis,
      });
    } else {
      options.setAxisOverlay(null);
    }
    updateRotateAngleOverlay(rotateController.getCurrentPreview());
  };

  let rotateCameraRefreshInFlight = false;
  let rotateCameraRefreshQueued = false;
  let rotateCameraRefreshViewport = { width: 1, height: 1 };
  const refreshRotateOverlaysFromCamera = (
    viewportWidth: number,
    viewportHeight: number,
  ) => {
    rotateCameraRefreshViewport = {
      width: viewportWidth,
      height: viewportHeight,
    };
    rotateCameraRefreshQueued = true;
    if (rotateCameraRefreshInFlight) return;
    rotateCameraRefreshInFlight = true;
    void (async () => {
      try {
        while (rotateCameraRefreshQueued) {
          rotateCameraRefreshQueued = false;
          const preview = rotateController.getCurrentPreview();
          if (!preview) return;
          const r = options.renderer();
          if (!r) return;
          const cameraState = await r.getCameraState();
          if (
            !rotateController.syncCamera(
              cameraState,
              rotateCameraRefreshViewport.width,
              rotateCameraRefreshViewport.height,
            )
          ) {
            return;
          }
          refreshRotateOverlayState(
            rotateCameraRefreshViewport.width,
            rotateCameraRefreshViewport.height,
          );
        }
      } finally {
        rotateCameraRefreshInFlight = false;
      }
    })();
  };

  const controllerFixtures = () =>
    options.transformables().map((entry) => ({
      uid: entry.uid,
      position: entry.position,
      rotation: entry.rotation,
    }));

  const applyRotatePreviewRotations = (
    r: IVisualizerRenderer,
    rotations: Array<{ uid: string; rotation: Vec3 }>,
  ) => {
    const transformableMap = new Map(
      options.transformables().map((entry) => [entry.uid, entry]),
    );
    for (const { uid, rotation } of rotations) {
      const target = transformableMap.get(uid);
      if (!target) continue;
      if (target.kind === "fixture") {
        r.setFixtureRotation(uid, rotation);
      } else {
        r.setSceneObjectRotation(uid, rotation);
      }
    }
  };

  const withRotateKinds = (
    rotations: Array<{ uid: string; rotation: Vec3 }>,
  ) => {
    const transformableMap = new Map(
      options.transformables().map((entry) => [entry.uid, entry]),
    );
    return rotations
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
          kind: RotateTransformableKind;
          rotation: Vec3;
        } => entry !== null,
      );
  };

  const updateRotateOriginOverlay = (
    viewportWidth: number,
    viewportHeight: number,
  ) => {
    const overlayState = rotateOriginState();
    if (!overlayState) {
      setRotateOriginOverlay(null);
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

    setRotateOriginOverlay(projected.length > 0 ? projected : null);
  };

  const continueRotateDrag = () => {
    const r = options.renderer();
    const commit = rotateController.endDrag(true);
    if (!commit) return null;

    if (r) {
      applyRotatePreviewRotations(r, commit.rotations);
    }

    if (commit.didRotate) {
      options.onCommitRotate(withRotateKinds(commit.rotations));
    }
    return commit;
  };

  const setRotateCameraDragSuppressed = (suppressed: boolean) => {
    options.renderer()?.setCameraDragEnabled(!suppressed);
  };

  const clearRotateReferenceSelection = (referenceUid: string | null) => {
    if (!referenceUid) return;
    options.dispatchProgrammerSelectionCommand([], {
      shiftKey: false,
      ctrlOrMetaKey: false,
    });
  };

  const cancelRotateOperation = () => {
    setRotateCameraDragSuppressed(false);
    const pointerState = rotateToolPointerState();
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
    clearRotateOriginOverlay();
    clearRotateAngleOverlay();
    clearRotateGizmoOverlay();

    const r = options.renderer();
    const preview = rotateController.cancelDrag();
    if (r && preview) {
      applyRotatePreviewRotations(r, preview.rotations);
    }

    if (hadOperation || preview !== null) {
      setRotateToolPointerState(nextState);
    }

    return hadOperation || preview !== null;
  };

  createEffect(() => {
    const pointerState = rotateToolPointerState();
    const preview = rotateController.getCurrentPreview();
    if (pointerState.dragPointerId !== null || pointerState.clickLockActive) {
      return;
    }
    if (!preview) return;

    const fixtures = controllerFixtures();
    const synced = rotateController.syncFromFixtures(fixtures);
    if (!synced) {
      return;
    }
    const canvas = options.canvasRef();
    refreshRotateOverlayState(
      canvas?.clientWidth || 1,
      canvas?.clientHeight || 1,
    );
  });

  createEffect(() => {
    if (!rotateToolPointerState().clickLockActive) return;
    const canvas = options.canvasRef();
    if (!canvas) return;

    const interval = setInterval(() => {
      refreshRotateOverlaysFromCamera(
        canvas.clientWidth || 1,
        canvas.clientHeight || 1,
      );
    }, 50);
    onCleanup(() => clearInterval(interval));
  });

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

  const canContinueRotatePointerDown = (pointerId: number): boolean => {
    if (!options.isRotateMode()) return false;
    if (!pressedPointerIds.has(pointerId)) return false;
    return !isToolOperationActive(rotateToolPointerState());
  };

  const handlers: VisualizerPointerHandlers = {
    onPointerDown: async (event) => {
      if (event.button !== 0) return;
      if (!options.canvasRef()) return;
      pressedPointerIds.add(event.pointerId);

      if (rotateToolPointerState().clickLockActive) {
        const activeAxis = rotateController.getGizmoOverlay()?.activeAxis;
        if (activeAxis) {
          const point = options.getCanvasScreenPoint(event);
          const commit = continueRotateDrag();
          if (!commit) {
            cancelRotateOperation();
            event.preventDefault();
            return;
          }
          setRotateCameraDragSuppressed(false);
          setRotateGizmoOverlay(rotateController.getGizmoOverlay());
          updateRotateAngleOverlay(rotateController.getCurrentPreview());
          if (point) {
            options.setAxisOverlay({
              centerX: point.x,
              centerY: point.y,
              lockedAxis: null,
            });
            updateRotateOriginOverlay(
              point.viewportWidth,
              point.viewportHeight,
            );
          } else {
            options.setAxisOverlay(null);
          }
          setRotateToolPointerState({
            dragPointerId: null,
            dragStartScreen: null,
            dragDidMove: false,
            clickLockActive: true,
          });
          event.preventDefault();
          return;
        }

        const point = options.getCanvasScreenPoint(event);
        if (!point) return;
        if (!tryCapturePointer(event.pointerId)) return;
        const overlayAxisHit = resolveAxisFromRotateOverlayHit(point);
        const axisLockPoint = overlayAxisHit
          ? {
              ...point,
              x: overlayAxisHit.dotX,
              y: overlayAxisHit.dotY,
            }
          : point;
        const lockedAxis = rotateController.beginAxisDrag(
          event.pointerId,
          axisLockPoint,
        );
        if (!lockedAxis) {
          releasePointerCaptureIfHeld(event.pointerId);
          const referenceUid = rotateAngleReferenceUid();
          cancelRotateOperation();
          clearRotateReferenceSelection(referenceUid);
          event.preventDefault();
          return;
        }
        setRotateCameraDragSuppressed(true);
        setRotateToolPointerState(startToolDrag(event.pointerId, point));
        options.setAxisOverlay({
          centerX: point.x,
          centerY: point.y,
          lockedAxis,
        });
        setRotateGizmoOverlay(rotateController.getGizmoOverlay());
        updateRotateAngleOverlay(rotateController.getCurrentPreview());
        event.preventDefault();
        return;
      }

      const r = options.renderer();
      const point = options.getCanvasScreenPoint(event);
      if (!r || !point) return;

      let dragStarted = false;
      try {
        let hitUid = await r.pickFixtureAtScreenPoint(point);
        if (!canContinueRotatePointerDown(event.pointerId)) return;
        if (!hitUid) {
          hitUid = await r.pickSceneObjectAtScreenPoint(point);
          if (!canContinueRotatePointerDown(event.pointerId)) return;
        }
        if (!hitUid) return;
        if (!tryCapturePointer(event.pointerId)) return;
        if (!canContinueRotatePointerDown(event.pointerId)) return;

        const cameraState = await r.getCameraState();
        if (!canContinueRotatePointerDown(event.pointerId)) return;
        const beginResult = rotateController.beginDrag({
          pointerId: event.pointerId,
          hitFixtureUid: hitUid,
          point,
          cameraState,
          selectedUids: options.selectedUids(),
          fixtures: controllerFixtures(),
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

        setRotateOriginState({
          cameraState,
          startPositions: beginResult.startPositions,
        });
        setRotateCameraDragSuppressed(true);
        setRotateToolPointerState(startToolDrag(event.pointerId, point));
        clearRotateAngleOverlay();
        setRotateAngleReferenceUid(hitUid);
        setRotateGizmoOverlay(rotateController.getGizmoOverlay());
        updateRotateAngleOverlay(rotateController.getCurrentPreview());
        updateRotateOriginOverlay(point.viewportWidth, point.viewportHeight);
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
      let pointerState = rotateToolPointerState();
      const trackingState = getPointerTrackingState(
        pointerState,
        event.pointerId,
      );
      if (!trackingState.isTracking) return;

      const r = options.renderer();
      if (!r) return;

      const preview = rotateController.updateDrag(point);
      if (!preview) return;

      if (trackingState.isActiveDragPointer && preview.lockedAxis) {
        const nextPointerState = updateDragDidMoveFromSlop(
          pointerState,
          point,
          ROTATE_CLICK_SLOP_PX,
        );
        if (nextPointerState !== pointerState) {
          pointerState = nextPointerState;
          setRotateToolPointerState(nextPointerState);
        }
      }

      updateRotateOriginOverlay(point.viewportWidth, point.viewportHeight);
      options.setAxisOverlay({
        centerX: point.x,
        centerY: point.y,
        lockedAxis: preview.lockedAxis,
      });
      setRotateGizmoOverlay(rotateController.getGizmoOverlay());
      updateRotateAngleOverlay(preview);

      applyRotatePreviewRotations(r, preview.rotations);
      event.preventDefault();
    },
    onPointerUp: (event) => {
      pressedPointerIds.delete(event.pointerId);
      const resolution = resolvePointerUp(
        rotateToolPointerState(),
        event.pointerId,
      );
      if (!resolution.handled) {
        if (rotateToolPointerState().clickLockActive) {
          const point = options.getCanvasScreenPoint(event);
          if (point) {
            refreshRotateOverlaysFromCamera(
              point.viewportWidth,
              point.viewportHeight,
            );
          }
        }
        return;
      }

      setRotateCameraDragSuppressed(false);

      const canvas = options.canvasRef();
      if (canvas?.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      if (resolution.didMove) {
        const commit = continueRotateDrag();
        clearRotateAngleOverlay();
        if (!commit) {
          options.setAxisOverlay(null);
          clearRotateOriginOverlay();
          clearRotateGizmoOverlay();
          setRotateToolPointerState(createIdleToolPointerState());
        } else {
          const point = options.getCanvasScreenPoint(event);
          setRotateGizmoOverlay(rotateController.getGizmoOverlay());
          updateRotateAngleOverlay(rotateController.getCurrentPreview());
          if (point) {
            options.setAxisOverlay({
              centerX: point.x,
              centerY: point.y,
              lockedAxis: null,
            });
          } else {
            options.setAxisOverlay(null);
          }
          setRotateToolPointerState({
            dragPointerId: null,
            dragStartScreen: null,
            dragDidMove: false,
            clickLockActive: true,
          });
        }
      } else {
        setRotateToolPointerState(resolution.nextState);
        if (resolution.nextState.clickLockActive) {
          updateRotateAngleOverlay(rotateController.getCurrentPreview());
        }
      }
      event.preventDefault();
    },
    onPointerCancel: (event) => {
      pressedPointerIds.delete(event.pointerId);
      const dragPointerId = rotateToolPointerState().dragPointerId;
      if (dragPointerId === null || event.pointerId !== dragPointerId) {
        return;
      }
      cancelRotateOperation();
    },
  };

  return {
    handlers,
    rotateOriginOverlay,
    rotateAngleOverlay,
    rotateGizmoOverlay,
    cancelRotateOperation,
    isOperationActive: () => isToolOperationActive(rotateToolPointerState()),
  };
}
