// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { VisualizerInteractionMode } from "../rendering/renderers/renderer-api";
import { createPointerModeRouter } from "./use-visualizer-pointer-mode-router";

type PointerPhase = "down" | "move" | "up" | "cancel";

function createHandlers(log: string[], label: string) {
  return {
    onPointerDown: () => {
      log.push(`${label}:down`);
    },
    onPointerMove: () => {
      log.push(`${label}:move`);
    },
    onPointerUp: () => {
      log.push(`${label}:up`);
    },
    onPointerCancel: () => {
      log.push(`${label}:cancel`);
    },
  };
}

/**
 * Dispatches one pointer phase through the visualizer pointer-mode router.
 */
function dispatchPhase(
  router: ReturnType<typeof createPointerModeRouter>,
  phase: PointerPhase,
) {
  const event = {} as PointerEvent;
  if (phase === "down") router.onPointerDown(event);
  if (phase === "move") router.onPointerMove(event);
  if (phase === "up") router.onPointerUp(event);
  if (phase === "cancel") router.onPointerCancel(event);
}

test("pointer mode router dispatches move/measure handlers by active mode", () => {
  let mode: VisualizerInteractionMode = "move";
  const calls: string[] = [];
  const router = createPointerModeRouter({
    getMode: () => mode,
    moveHandlers: createHandlers(calls, "move"),
    rotateHandlers: createHandlers(calls, "rotate"),
    measureHandlers: createHandlers(calls, "measure"),
    selectionHandlers: createHandlers(calls, "selection"),
  });

  dispatchPhase(router, "down");
  mode = "measure";
  dispatchPhase(router, "move");
  mode = "move";
  dispatchPhase(router, "up");

  assert.deepEqual(calls, ["move:down", "measure:move", "move:up"]);
});

test("pointer mode router only uses selection handlers for select mode", () => {
  let mode: VisualizerInteractionMode = "camera";
  const calls: string[] = [];
  const router = createPointerModeRouter({
    getMode: () => mode,
    moveHandlers: createHandlers(calls, "move"),
    rotateHandlers: createHandlers(calls, "rotate"),
    measureHandlers: createHandlers(calls, "measure"),
    selectionHandlers: createHandlers(calls, "selection"),
  });

  dispatchPhase(router, "down");
  mode = "select";
  dispatchPhase(router, "cancel");

  assert.deepEqual(calls, ["selection:cancel"]);
});

test("pointer mode router dispatches rotate handlers in rotate mode", () => {
  const mode: VisualizerInteractionMode = "rotate";
  const calls: string[] = [];
  const router = createPointerModeRouter({
    getMode: () => mode,
    moveHandlers: createHandlers(calls, "move"),
    rotateHandlers: createHandlers(calls, "rotate"),
    measureHandlers: createHandlers(calls, "measure"),
    selectionHandlers: createHandlers(calls, "selection"),
  });

  dispatchPhase(router, "down");
  dispatchPhase(router, "move");
  dispatchPhase(router, "up");

  assert.deepEqual(calls, ["rotate:down", "rotate:move", "rotate:up"]);
});
