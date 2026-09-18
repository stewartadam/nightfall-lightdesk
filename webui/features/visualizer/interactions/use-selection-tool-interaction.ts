// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Selection-tool interaction hook for Visualizer.
 *
 * Handles click selection and drag-rectangle selection, owns pointer capture for
 * the active selection gesture, and exposes overlay style data for the marquee.
 */

import { createMemo, createSignal } from "solid-js";
import type {
  IVisualizerRenderer,
  VisualizerScreenPoint,
  VisualizerScreenRect,
} from "../rendering/renderers/renderer-api";
import type { VisualizerPointerHandlers } from "./use-visualizer-pointer-mode-router";

interface SelectionModifiers {
  shiftKey: boolean;
  ctrlOrMetaKey: boolean;
}

interface UseSelectionToolInteractionOptions {
  canvasRef: () => HTMLCanvasElement | undefined;
  renderer: () => IVisualizerRenderer | null;
  getCanvasScreenPoint: (event: PointerEvent) => VisualizerScreenPoint | null;
  dispatchProgrammerSelectionCommand: (
    uids: readonly string[],
    modifiers: SelectionModifiers,
  ) => void;
}

/**
 * Creates pointer handlers and overlay state for selection mode interactions.
 */
export function useSelectionToolInteraction(
  options: UseSelectionToolInteractionOptions,
) {
  const [selectionDragRect, setSelectionDragRect] =
    createSignal<VisualizerScreenRect | null>(null);
  const [selectionPointerId, setSelectionPointerId] = createSignal<
    number | null
  >(null);

  const clearSelectionDrag = () => {
    setSelectionDragRect(null);
    setSelectionPointerId(null);
  };

  const selectionOverlayStyle = createMemo(() => {
    const rect = selectionDragRect();
    if (!rect) return undefined;
    const minX = Math.min(rect.startX, rect.endX);
    const minY = Math.min(rect.startY, rect.endY);
    const width = Math.abs(rect.endX - rect.startX);
    const height = Math.abs(rect.endY - rect.startY);
    return {
      position: "absolute",
      left: `${minX}px`,
      top: `${minY}px`,
      width: `${width}px`,
      height: `${height}px`,
      border: "1px solid rgba(96, 165, 250, 0.9)",
      background: "rgba(59, 130, 246, 0.18)",
      "pointer-events": "none",
    } as const;
  });

  const handlers: VisualizerPointerHandlers = {
    onPointerDown: (event) => {
      if (event.button !== 0) return;

      const point = options.getCanvasScreenPoint(event);
      const canvas = options.canvasRef();
      if (!point || !canvas) return;

      setSelectionPointerId(event.pointerId);
      setSelectionDragRect({
        startX: point.x,
        startY: point.y,
        endX: point.x,
        endY: point.y,
        viewportWidth: point.viewportWidth,
        viewportHeight: point.viewportHeight,
      });
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    onPointerMove: (event) => {
      const activePointerId = selectionPointerId();
      const currentRect = selectionDragRect();
      if (activePointerId === null || !currentRect) return;
      if (event.pointerId !== activePointerId) return;

      const point = options.getCanvasScreenPoint(event);
      if (!point) return;

      setSelectionDragRect({
        ...currentRect,
        endX: point.x,
        endY: point.y,
        viewportWidth: point.viewportWidth,
        viewportHeight: point.viewportHeight,
      });
      event.preventDefault();
    },
    onPointerUp: async (event) => {
      const activePointerId = selectionPointerId();
      const currentRect = selectionDragRect();
      const r = options.renderer();

      if (
        activePointerId === null ||
        !currentRect ||
        event.pointerId !== activePointerId ||
        !r
      ) {
        return;
      }

      const canvas = options.canvasRef();
      if (canvas?.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      clearSelectionDrag();
      event.preventDefault();

      const width = Math.abs(currentRect.endX - currentRect.startX);
      const height = Math.abs(currentRect.endY - currentRect.startY);
      const isClickSelection = width < 4 && height < 4;

      let selectedUids: string[] = [];
      if (isClickSelection) {
        const point = {
          x: currentRect.endX,
          y: currentRect.endY,
          viewportWidth: currentRect.viewportWidth,
          viewportHeight: currentRect.viewportHeight,
        };
        const uid =
          (await r.pickFixtureAtScreenPoint(point)) ??
          (await r.pickSceneObjectAtScreenPoint(point));
        if (uid) {
          selectedUids = [uid];
        }
      } else {
        selectedUids = await r.pickFixturesInScreenRect(currentRect);
      }

      options.dispatchProgrammerSelectionCommand(selectedUids, {
        shiftKey: event.shiftKey,
        ctrlOrMetaKey: event.ctrlKey || event.metaKey,
      });
    },
    onPointerCancel: (event) => {
      const activePointerId = selectionPointerId();
      if (activePointerId === null || event.pointerId !== activePointerId) {
        return;
      }

      const canvas = options.canvasRef();
      if (canvas?.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      clearSelectionDrag();
    },
  };

  return {
    selectionOverlayStyle,
    clearSelectionDrag,
    handlers,
  };
}
