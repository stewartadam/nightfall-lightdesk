// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Measure-tool interaction hook for Visualizer.
 *
 * Manages pointer capture and click-lock behavior for one-shot measurements,
 * computes axis-locked previews, and exposes overlay state for rendering lines
 * and distance labels in screen space.
 */

import { createSignal } from "solid-js";
import {
  intersectScreenPointWithHorizontalPlane,
  projectWorldPointToScreen,
  VisualizerMeasureController,
} from "../controllers/visualizer-measure-controller";
import type {
  IVisualizerRenderer,
  Vec3,
  VisualizerScreenPoint,
} from "../rendering/renderers/renderer-api";
import type { VisualizerPointerHandlers } from "./use-visualizer-pointer-mode-router";
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

const MEASURE_CLICK_SLOP_PX = 4;

interface AxisOverlay {
  centerX: number;
  centerY: number;
  lockedAxis: Axis | null;
}

interface MeasureFixture {
  uid: string;
  position: Vec3;
}

interface UseMeasureToolInteractionOptions {
  canvasRef: () => HTMLCanvasElement | undefined;
  renderer: () => IVisualizerRenderer | null;
  fixtures: () => readonly MeasureFixture[];
  isMeasureMode: () => boolean;
  getCanvasScreenPoint: (event: PointerEvent) => VisualizerScreenPoint | null;
  setAxisOverlay: (overlay: AxisOverlay | null) => void;
}

/**
 * Creates measure-mode pointer handlers and reactive measurement overlay state.
 */
export function useMeasureToolInteraction(
  options: UseMeasureToolInteractionOptions,
) {
  const measureController = new VisualizerMeasureController();
  const [measureToolPointerState, setMeasureToolPointerState] = createSignal(
    createIdleToolPointerState(),
  );
  const [measureOverlay, setMeasureOverlay] = createSignal<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    label: string;
    axis: Axis;
  } | null>(null);

  const clearMeasureOverlay = () => {
    setMeasureOverlay(null);
  };

  const setMeasureCameraDragSuppressed = (suppressed: boolean) => {
    options.renderer()?.setCameraDragEnabled(!suppressed);
  };

  const cancelMeasureOperation = () => {
    setMeasureCameraDragSuppressed(false);
    const pointerState = measureToolPointerState();
    const { hadOperation, nextState } = clearToolPointerState(pointerState);

    measureController.cancelMeasure();
    clearMeasureOverlay();
    options.setAxisOverlay(null);
    if (hadOperation) {
      setMeasureToolPointerState(nextState);
    }

    return hadOperation;
  };

  const handlers: VisualizerPointerHandlers = {
    onPointerDown: (event) => {
      if (event.button !== 0) return;

      if (measureToolPointerState().clickLockActive) {
        setMeasureCameraDragSuppressed(false);
        measureController.endMeasure();
        clearMeasureOverlay();
        options.setAxisOverlay(null);
        setMeasureToolPointerState(createIdleToolPointerState());
        event.preventDefault();
        return;
      }

      const point = options.getCanvasScreenPoint(event);
      if (!point) return;

      // Track down/up locally so click (not drag) can enter measure mode.
      setMeasureToolPointerState(startToolDrag(event.pointerId, point));
    },
    onPointerMove: (event) => {
      const point = options.getCanvasScreenPoint(event);
      if (!point) return;
      let pointerState = measureToolPointerState();
      const trackingState = getPointerTrackingState(
        pointerState,
        event.pointerId,
      );
      if (!trackingState.isTracking) return;

      if (pointerState.clickLockActive) {
        const preview = measureController.updateMeasure(point, event.shiftKey);
        options.setAxisOverlay({
          centerX: point.x,
          centerY: point.y,
          lockedAxis: preview?.lockedAxis ?? null,
        });
        const cameraState = measureController.getCameraState();
        if (
          !preview ||
          !cameraState ||
          !preview.lockedAxis ||
          !preview.endPoint ||
          preview.distance <= 0
        ) {
          clearMeasureOverlay();
          return;
        }

        const startScreen = projectWorldPointToScreen(
          preview.startPoint,
          cameraState,
          point.viewportWidth,
          point.viewportHeight,
        );
        const endScreen = projectWorldPointToScreen(
          preview.endPoint,
          cameraState,
          point.viewportWidth,
          point.viewportHeight,
        );
        if (!startScreen || !endScreen) {
          clearMeasureOverlay();
          return;
        }

        setMeasureOverlay({
          startX: startScreen.x,
          startY: startScreen.y,
          endX: endScreen.x,
          endY: endScreen.y,
          label: `${preview.lockedAxis.toUpperCase()}: ${preview.distance.toFixed(2)}m`,
          axis: preview.lockedAxis,
        });
        event.preventDefault();
        return;
      }

      if (trackingState.isActiveDragPointer) {
        const nextPointerState = updateDragDidMoveFromSlop(
          pointerState,
          point,
          MEASURE_CLICK_SLOP_PX,
        );
        if (nextPointerState !== pointerState) {
          pointerState = nextPointerState;
          setMeasureToolPointerState(nextPointerState);
        }
      }
    },
    onPointerUp: async (event) => {
      const resolution = resolvePointerUp(
        measureToolPointerState(),
        event.pointerId,
      );
      if (!resolution.handled) return;

      if (resolution.didMove) {
        setMeasureToolPointerState(resolution.nextState);
        setMeasureCameraDragSuppressed(false);
        return;
      }

      const r = options.renderer();
      const point = options.getCanvasScreenPoint(event);
      if (!r || !point) {
        setMeasureToolPointerState(createIdleToolPointerState());
        setMeasureCameraDragSuppressed(false);
        return;
      }

      const cameraState = await r.getCameraState();
      const hitUid = await r.pickFixtureAtScreenPoint(point);

      let startPoint: Vec3 | null = null;
      if (hitUid) {
        const hitFixture = options
          .fixtures()
          .find((fixture) => fixture.uid === hitUid);
        if (hitFixture) {
          startPoint = { ...hitFixture.position };
        }
      }

      if (!startPoint) {
        startPoint = intersectScreenPointWithHorizontalPlane(
          point,
          0,
          cameraState,
        );
      }
      if (!startPoint) {
        setMeasureToolPointerState(createIdleToolPointerState());
        setMeasureCameraDragSuppressed(false);
        return;
      }

      measureController.beginMeasure({
        pointerId: event.pointerId,
        startPoint,
        startScreenPoint: point,
        cameraState,
      });

      clearMeasureOverlay();
      options.setAxisOverlay({
        centerX: point.x,
        centerY: point.y,
        lockedAxis: null,
      });
      setMeasureToolPointerState({
        dragPointerId: null,
        dragStartScreen: null,
        dragDidMove: false,
        clickLockActive: true,
      });
      setMeasureCameraDragSuppressed(true);
      event.preventDefault();
    },
    onPointerCancel: (event) => {
      const dragPointerId = measureToolPointerState().dragPointerId;
      if (dragPointerId === null || event.pointerId !== dragPointerId) {
        return;
      }
      cancelMeasureOperation();
    },
  };

  return {
    handlers,
    measureOverlay,
    cancelMeasureOperation,
    isOperationActive: () => isToolOperationActive(measureToolPointerState()),
  };
}
