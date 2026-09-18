// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  IVisualizerRenderer,
  VisualizerScreenPoint,
} from "../rendering/renderers/renderer-api";
import { useSelectionToolInteraction } from "./use-selection-tool-interaction";

interface SelectionDispatchCall {
  uids: readonly string[];
  modifiers: {
    shiftKey: boolean;
    ctrlOrMetaKey: boolean;
  };
}

function createMockCanvas() {
  const captured = new Set<number>();
  return {
    setPointerCapture: (pointerId: number) => {
      captured.add(pointerId);
    },
    hasPointerCapture: (pointerId: number) => captured.has(pointerId),
    releasePointerCapture: (pointerId: number) => {
      captured.delete(pointerId);
    },
  };
}

function createPointerEvent(
  pointerId: number,
  point: VisualizerScreenPoint,
  modifiers?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
) {
  return {
    button: 0,
    pointerId,
    shiftKey: modifiers?.shiftKey ?? false,
    ctrlKey: modifiers?.ctrlKey ?? false,
    metaKey: modifiers?.metaKey ?? false,
    clientX: point.x,
    clientY: point.y,
    preventDefault: () => {},
  } as unknown as PointerEvent;
}

test("selection interaction click-select dispatches picked fixture", async () => {
  const canvas = createMockCanvas();
  const dispatchCalls: SelectionDispatchCall[] = [];
  const lastPoint: VisualizerScreenPoint = {
    x: 10,
    y: 20,
    viewportWidth: 100,
    viewportHeight: 80,
  };

  const renderer = {
    pickFixtureAtScreenPoint: async () => "fixture-1",
    pickFixturesInScreenRect: async () => [],
  } as unknown as IVisualizerRenderer;

  const selection = useSelectionToolInteraction({
    canvasRef: () => canvas as unknown as HTMLCanvasElement,
    renderer: () => renderer,
    getCanvasScreenPoint: () => lastPoint,
    dispatchProgrammerSelectionCommand: (uids, modifiers) => {
      dispatchCalls.push({ uids, modifiers });
    },
  });

  selection.handlers.onPointerDown(createPointerEvent(3, lastPoint));

  await selection.handlers.onPointerUp(createPointerEvent(3, lastPoint));

  assert.equal(dispatchCalls.length, 1);
  assert.deepEqual(dispatchCalls[0], {
    uids: ["fixture-1"],
    modifiers: {
      shiftKey: false,
      ctrlOrMetaKey: false,
    },
  });
  assert.equal(selection.selectionOverlayStyle(), undefined);
});

test("selection interaction click-select dispatches picked scene object", async () => {
  const canvas = createMockCanvas();
  const dispatchCalls: SelectionDispatchCall[] = [];
  const lastPoint: VisualizerScreenPoint = {
    x: 12,
    y: 24,
    viewportWidth: 100,
    viewportHeight: 80,
  };

  const renderer = {
    pickFixtureAtScreenPoint: async () => null,
    pickSceneObjectAtScreenPoint: async () => "scene-object-1",
    pickFixturesInScreenRect: async () => [],
  } as unknown as IVisualizerRenderer;

  const selection = useSelectionToolInteraction({
    canvasRef: () => canvas as unknown as HTMLCanvasElement,
    renderer: () => renderer,
    getCanvasScreenPoint: () => lastPoint,
    dispatchProgrammerSelectionCommand: (uids, modifiers) => {
      dispatchCalls.push({ uids, modifiers });
    },
  });

  selection.handlers.onPointerDown(createPointerEvent(4, lastPoint));

  await selection.handlers.onPointerUp(createPointerEvent(4, lastPoint));

  assert.equal(dispatchCalls.length, 1);
  assert.deepEqual(dispatchCalls[0], {
    uids: ["scene-object-1"],
    modifiers: {
      shiftKey: false,
      ctrlOrMetaKey: false,
    },
  });
});

test("selection interaction drag-select dispatches rectangle picks", async () => {
  const canvas = createMockCanvas();
  const dispatchCalls: SelectionDispatchCall[] = [];
  let lastPoint: VisualizerScreenPoint = {
    x: 5,
    y: 5,
    viewportWidth: 120,
    viewportHeight: 90,
  };

  const renderer = {
    pickFixtureAtScreenPoint: async () => null,
    pickFixturesInScreenRect: async () => ["fixture-2", "fixture-3"],
  } as unknown as IVisualizerRenderer;

  const selection = useSelectionToolInteraction({
    canvasRef: () => canvas as unknown as HTMLCanvasElement,
    renderer: () => renderer,
    getCanvasScreenPoint: () => lastPoint,
    dispatchProgrammerSelectionCommand: (uids, modifiers) => {
      dispatchCalls.push({ uids, modifiers });
    },
  });

  selection.handlers.onPointerDown(createPointerEvent(7, lastPoint));

  lastPoint = {
    x: 28,
    y: 31,
    viewportWidth: 120,
    viewportHeight: 90,
  };
  selection.handlers.onPointerMove(createPointerEvent(7, lastPoint));

  await selection.handlers.onPointerUp(
    createPointerEvent(7, lastPoint, { shiftKey: true }),
  );

  assert.equal(dispatchCalls.length, 1);
  assert.deepEqual(dispatchCalls[0], {
    uids: ["fixture-2", "fixture-3"],
    modifiers: {
      shiftKey: true,
      ctrlOrMetaKey: false,
    },
  });
});
