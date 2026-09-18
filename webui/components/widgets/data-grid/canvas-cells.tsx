// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type {
  CustomCell,
  CustomRenderer,
  GridCell,
} from "../../../lib/data-grid-types";
import { dataGridDarkTheme } from "../../../lib/datagrid";
import type { DataGridCellDecorationCallback } from "./model/types";

/** Renders custom cells onto a canvas using the native data-grid renderer API. */
export function CustomCellCanvas(props: {
  cell: CustomCell;
  col: number;
  row: number;
  renderer: CustomRenderer;
}) {
  let canvasRef: HTMLCanvasElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const [sizeRevision, setSizeRevision] = createSignal(0);

  /** Draws the custom cell into the current canvas bounds and device scale. */
  const draw = () => {
    sizeRevision();
    const canvas = canvasRef;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(bounds.width * ratio));
    const pixelHeight = Math.max(1, Math.round(bounds.height * ratio));
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

  /** Redraws when the cell inputs or canvas size revision change. */
  createEffect(draw);

  /** Watches canvas size changes so custom renderers stay pixel aligned. */
  onMount(() => {
    if (!canvasRef) return;
    resizeObserver = new ResizeObserver(() => {
      setSizeRevision((revision) => revision + 1);
    });
    resizeObserver.observe(canvasRef);
    onCleanup(() => resizeObserver?.disconnect());
  });

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
  let resizeObserver: ResizeObserver | undefined;
  const [sizeRevision, setSizeRevision] = createSignal(0);

  /** Draws the decoration callback into the current canvas bounds. */
  const draw = () => {
    sizeRevision();
    void props.redrawKey;
    const canvas = canvasRef;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(bounds.width * ratio));
    const pixelHeight = Math.max(1, Math.round(bounds.height * ratio));
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

  /** Redraws when cell inputs, redraw keys, or size revisions change. */
  createEffect(draw);

  /** Watches canvas size changes so decoration overlays match cell bounds. */
  onMount(() => {
    if (!canvasRef) return;
    resizeObserver = new ResizeObserver(() => {
      setSizeRevision((revision) => revision + 1);
    });
    resizeObserver.observe(canvasRef);
    onCleanup(() => resizeObserver?.disconnect());
  });

  return (
    <canvas
      ref={canvasRef}
      class="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
