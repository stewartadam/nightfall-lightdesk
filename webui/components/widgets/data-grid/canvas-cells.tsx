// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Accessor,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type {
  CustomCell,
  CustomRenderer,
  GridCell,
} from "../../../lib/data-grid-types";
import { dataGridDarkTheme } from "../../../lib/datagrid";
import type { DataGridCellDecorationCallback } from "./model/types";

/** CSS pixel size of a cell canvas. */
interface CanvasSize {
  width: number;
  height: number;
}

/**
 * Tracks a canvas's CSS size through a ResizeObserver. Draws read this size instead of
 * calling getBoundingClientRect, which forces a synchronous layout for every redrawn cell
 * while the grid is applying a data update.
 */
function createObservedCanvasSize(
  canvas: () => HTMLCanvasElement | undefined,
): Accessor<CanvasSize | undefined> {
  const [size, setSize] = createSignal<CanvasSize | undefined>(undefined, {
    equals: (previous, next) =>
      previous?.width === next?.width && previous?.height === next?.height,
  });
  onMount(() => {
    const element = canvas();
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  return size;
}

/**
 * Matches the canvas backing store to `size` at the device pixel ratio and returns a cleared
 * context scaled to CSS pixels, or undefined when there is nothing to draw into. Callers
 * restore the context after drawing.
 */
function beginCanvasDraw(
  canvas: HTMLCanvasElement | undefined,
  size: CanvasSize | undefined,
): CanvasRenderingContext2D | undefined {
  if (!canvas || !size || size.width <= 0 || size.height <= 0) return;

  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(size.width * ratio));
  const pixelHeight = Math.max(1, Math.round(size.height * ratio));
  if (canvas.width !== pixelWidth) {
    canvas.width = pixelWidth;
  }
  if (canvas.height !== pixelHeight) {
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(ratio, ratio);
  return ctx;
}

/** Renders custom cells onto a canvas using the native data-grid renderer API. */
export function CustomCellCanvas(props: {
  cell: CustomCell;
  col: number;
  row: number;
  renderer: CustomRenderer;
}) {
  let canvasRef: HTMLCanvasElement | undefined;
  const size = createObservedCanvasSize(() => canvasRef);

  /** Draws the custom cell into the observed canvas size and device scale. */
  const draw = () => {
    const bounds = size();
    const ctx = beginCanvasDraw(canvasRef, bounds);
    if (!ctx || !bounds) return;
    const theme = {
      ...dataGridDarkTheme,
      ...(props.cell.themeOverride ?? {}),
    };
    props.renderer.draw({
      ctx,
      theme,
      col: props.col,
      row: props.row,
      rect: {
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height,
      },
      cell: props.cell as never,
    });
    ctx.restore();
  };

  /** Redraws when the cell inputs or observed canvas size change. */
  createEffect(draw);

  return <canvas ref={canvasRef} class="h-full w-full" />;
}

/** Renders optional per-cell decoration overlays onto a transparent canvas. */
export function CellDecorationCanvas(props: {
  cell: GridCell;
  col: number;
  row: number;
  drawDecoration: DataGridCellDecorationCallback;
  redrawKey?: unknown;
}) {
  let canvasRef: HTMLCanvasElement | undefined;
  const size = createObservedCanvasSize(() => canvasRef);

  /** Draws the decoration callback into the observed canvas size. */
  const draw = () => {
    void props.redrawKey;
    const bounds = size();
    const ctx = beginCanvasDraw(canvasRef, bounds);
    if (!ctx || !bounds) return;
    props.drawDecoration({
      ctx,
      cell: props.cell,
      rect: {
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height,
      },
      col: props.col,
      row: props.row,
    });
    ctx.restore();
  };

  /** Redraws when cell inputs, redraw keys, or the observed canvas size change. */
  createEffect(draw);

  return (
    <canvas
      ref={canvasRef}
      class="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
