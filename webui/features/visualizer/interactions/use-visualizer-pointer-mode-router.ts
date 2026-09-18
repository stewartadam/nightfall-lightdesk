// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Pointer-event router for Visualizer interaction modes.
 *
 * The canvas always forwards pointer events through one handler set, and this
 * router delegates each event to the tool-specific handler collection for the
 * current mode.
 */

import type { VisualizerInteractionMode } from "../rendering/renderers/renderer-api";

/**
 * Normalized pointer handler shape used by all Visualizer interaction tools.
 */
export interface VisualizerPointerHandlers {
  onPointerDown: (event: PointerEvent) => void | Promise<void>;
  onPointerMove: (event: PointerEvent) => void | Promise<void>;
  onPointerUp: (event: PointerEvent) => void | Promise<void>;
  onPointerCancel: (event: PointerEvent) => void | Promise<void>;
}

interface CreatePointerModeRouterOptions {
  getMode: () => VisualizerInteractionMode;
  moveHandlers: VisualizerPointerHandlers;
  rotateHandlers: VisualizerPointerHandlers;
  measureHandlers: VisualizerPointerHandlers;
  selectionHandlers: VisualizerPointerHandlers;
}

const NOOP_POINTER_HANDLERS: VisualizerPointerHandlers = {
  onPointerDown: () => {},
  onPointerMove: () => {},
  onPointerUp: () => {},
  onPointerCancel: () => {},
};

function resolveHandlersForMode(
  mode: VisualizerInteractionMode,
  options: CreatePointerModeRouterOptions,
): VisualizerPointerHandlers {
  if (mode === "camera") return NOOP_POINTER_HANDLERS;
  if (mode === "move") return options.moveHandlers;
  if (mode === "rotate") return options.rotateHandlers;
  if (mode === "measure") return options.measureHandlers;
  return options.selectionHandlers;
}

/**
 * Creates a stable pointer handler set that dispatches to mode-specific handlers.
 *
 * Camera mode intentionally routes to no-op handlers so camera controls can own
 * pointer interaction without running selection logic in parallel.
 */
export function createPointerModeRouter(
  options: CreatePointerModeRouterOptions,
): VisualizerPointerHandlers {
  return {
    onPointerDown: (event) => {
      void resolveHandlersForMode(options.getMode(), options).onPointerDown(
        event,
      );
    },
    onPointerMove: (event) => {
      void resolveHandlersForMode(options.getMode(), options).onPointerMove(
        event,
      );
    },
    onPointerUp: (event) => {
      void resolveHandlersForMode(options.getMode(), options).onPointerUp(
        event,
      );
    },
    onPointerCancel: (event) => {
      void resolveHandlersForMode(options.getMode(), options).onPointerCancel(
        event,
      );
    },
  };
}
