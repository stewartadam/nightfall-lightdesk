// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ciePreviewPointToE154Rgb } from "../../../lib/color-path-preview";
import type * as types from "../../../types";
import {
  CIE_SPECTRAL_LOCUS_POLYGON,
  type ColorPathPreviewPoint,
  ciePreviewDisplayColor,
  E154_RGB_TRIANGLE_POLYGON,
  previewPointInsideFixtureRgbGamut,
  type RouteAnchor,
  svgPointList,
} from "../model/color-path-model";

interface RouteOverlayProps {
  points: readonly ColorPathPreviewPoint[];
  onAnchorColorChange: (anchor: RouteAnchor, color: types.ColorPathRgb) => void;
}

/** Paints a device-pixel CIE xy preview background into the provided canvas. */
function paintCieChromaticityBackground(canvas: HTMLCanvasElement): void {
  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));

  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }

  const context = canvas.getContext("2d");
  if (!context) return;

  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const previewX = (x + 0.5) / width;
      const previewY = (y + 0.5) / height;
      const offset = (y * width + x) * 4;
      const color = ciePreviewDisplayColor({ x: previewX, y: previewY });
      image.data[offset] = Math.round(color.red * 255);
      image.data[offset + 1] = Math.round(color.green * 255);
      image.data[offset + 2] = Math.round(color.blue * 255);
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

/** Renders the CIE xy chromaticity field as a canvas sampled at display resolution. */
function CieChromaticityBackground() {
  let canvas: HTMLCanvasElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

  /** Repaints the canvas after the element is mounted or resized. */
  const paint = () => {
    if (!canvas) return;
    paintCieChromaticityBackground(canvas);
  };

  onMount(() => {
    paint();
    if (!canvas || typeof ResizeObserver === "undefined") return;
    resizeObserver = new ResizeObserver(paint);
    resizeObserver.observe(canvas);
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
  });

  return (
    <canvas
      ref={canvas}
      class="absolute inset-0 h-full w-full"
      data-testid="cie-chromaticity-background"
    />
  );
}

/** Renders a CIE xy chromaticity preview from sampled color path points. */
export function RouteOverlay(props: RouteOverlayProps) {
  let overlaySvg: SVGSVGElement | undefined;
  const [dragAnchor, setDragAnchor] = createSignal<RouteAnchor | null>(null);

  /** Returns the source and destination color points for the simplified route overlay. */
  const routeEndpoints = () => {
    const first = props.points[0];
    const last = props.points[props.points.length - 1];
    if (!first || !last) return null;
    return { first, last };
  };

  /** Converts a pointer event into normalized preview coordinates. */
  const previewPointFromPointer = (event: PointerEvent) => {
    if (!overlaySvg) return null;
    const bounds = overlaySvg.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  /** Applies a pointer position to a route anchor when it is inside the fixture RGB gamut. */
  const updateAnchorFromPointer = (
    anchor: RouteAnchor,
    event: PointerEvent,
  ) => {
    const point = previewPointFromPointer(event);
    if (!point || !previewPointInsideFixtureRgbGamut(point)) {
      return;
    }
    props.onAnchorColorChange(
      anchor,
      ciePreviewPointToE154Rgb(point.x, point.y),
    );
  };

  /** Starts an anchor drag operation from the selected endpoint. */
  const handleAnchorPointerDown = (
    anchor: RouteAnchor,
    event: PointerEvent,
  ) => {
    event.preventDefault();
    setDragAnchor(anchor);
    overlaySvg?.setPointerCapture(event.pointerId);
    updateAnchorFromPointer(anchor, event);
  };

  /** Updates the active anchor while the pointer is captured by the overlay. */
  const handleOverlayPointerMove = (event: PointerEvent) => {
    const anchor = dragAnchor();
    if (!anchor) return;
    updateAnchorFromPointer(anchor, event);
  };

  /** Ends the active anchor drag and releases pointer capture. */
  const handleOverlayPointerUp = (event: PointerEvent) => {
    setDragAnchor(null);
    if (overlaySvg?.hasPointerCapture(event.pointerId)) {
      overlaySvg.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      class="relative aspect-square w-full overflow-hidden rounded border border-neutral-800 bg-neutral-950"
      data-testid="color-path-route-overlay"
      role="img"
      aria-label="Color path route"
    >
      <CieChromaticityBackground />
      <svg
        ref={overlaySvg}
        class="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        aria-hidden="true"
        onPointerMove={handleOverlayPointerMove}
        onPointerUp={handleOverlayPointerUp}
        onPointerCancel={handleOverlayPointerUp}
      >
        <rect width="100" height="100" fill="#020617" opacity="0.18" />
        <polygon
          points={CIE_SPECTRAL_LOCUS_POLYGON}
          data-testid="cie-spectral-locus"
          fill="none"
          stroke="rgba(255,255,255,0.62)"
          stroke-width="0.45"
        />
        <polygon
          points={E154_RGB_TRIANGLE_POLYGON}
          data-testid="cie-e154-rgb-triangle"
          fill="none"
          stroke="rgba(255,255,255,0.46)"
          stroke-width="0.6"
        />
        <Show when={routeEndpoints()}>
          {(endpoints) => (
            <>
              <polyline
                points={svgPointList(props.points)}
                data-testid="cie-route-endpoint-line"
                fill="none"
                stroke="#050505"
                stroke-width="0.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <For
                each={[
                  { anchor: "start" as const, point: endpoints().first },
                  { anchor: "end" as const, point: endpoints().last },
                ]}
              >
                {(entry) => (
                  <circle
                    data-testid="cie-route-endpoint"
                    data-anchor={entry.anchor}
                    cx={entry.point.x * 100}
                    cy={entry.point.y * 100}
                    r="2.55"
                    fill={entry.point.cieHex}
                    class="cursor-grab touch-none active:cursor-grabbing"
                    stroke="#111827"
                    stroke-width="0.8"
                    onPointerDown={(event) =>
                      handleAnchorPointerDown(entry.anchor, event)
                    }
                  />
                )}
              </For>
            </>
          )}
        </Show>
      </svg>
    </div>
  );
}
