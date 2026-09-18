// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, onCleanup, onMount } from "solid-js";
import { colorPathSamples } from "../../../lib/color-path-preview";
import type * as types from "../../../types";
import {
  percentInputFraction,
  percentInputValue,
  type RouteAnchor,
} from "../model/color-path-model";

interface PreviewColorInputProps {
  anchor: RouteAnchor;
  label: string;
  value: string;
  fixtureHex: string;
  onInput: (value: string) => void;
}

interface ColorPathGradientCanvasProps {
  path: types.ColorPath;
  start: types.ColorPathRgb;
  end: types.ColorPathRgb;
}

/** Converts a normalized RGB channel into an eight-bit canvas channel. */
function colorPathCanvasChannel(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

/** Paints the color path gradient preview at the canvas backing resolution. */
function paintColorPathGradientCanvas(
  canvas: HTMLCanvasElement,
  path: types.ColorPath,
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
): void {
  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(2, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));

  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }

  const context = canvas.getContext("2d");
  if (!context) return;

  const samples = colorPathSamples(path, start, end, width);
  const image = context.createImageData(width, height);
  for (let x = 0; x < width; x++) {
    const color = samples[x] ?? end;
    const red = colorPathCanvasChannel(color.red);
    const green = colorPathCanvasChannel(color.green);
    const blue = colorPathCanvasChannel(color.blue);
    for (let y = 0; y < height; y++) {
      const offset = (y * width + x) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

/** Renders a high-resolution color path gradient preview. */
export function ColorPathGradientCanvas(props: ColorPathGradientCanvasProps) {
  let canvas: HTMLCanvasElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

  /** Repaints the gradient using the current path and anchor colors. */
  const paint = () => {
    const path = props.path;
    const start = props.start;
    const end = props.end;
    if (!canvas) return;
    paintColorPathGradientCanvas(canvas, path, start, end);
  };

  createEffect(paint);

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
      class="block h-10 w-full rounded border border-neutral-800"
      data-testid="color-path-gradient-canvas"
    />
  );
}

/** Renders an editable native color input with a projected CIE display swatch. */
export function PreviewColorInput(props: PreviewColorInputProps) {
  return (
    <label class="block space-y-1 text-sm">
      <span class="text-neutral-400">{props.label}</span>
      <span
        class="relative block h-10 w-full overflow-hidden rounded border border-neutral-700"
        data-anchor={props.anchor}
        data-testid="color-path-preview-color-control"
        style={{ "background-color": props.fixtureHex }}
      >
        <input
          class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          type="color"
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
      </span>
    </label>
  );
}

interface TimingComponentEditorProps {
  label: string;
  mode: "in" | "out";
  component: types.ColorPathTimingComponent | undefined;
  disabled: boolean;
  onChange: (component: types.ColorPathTimingComponent | undefined) => void;
}

/** Compact editor for an optional path-level timing component. */
export function TimingComponentEditor(props: TimingComponentEditorProps) {
  const sliderValue = () => {
    if (!props.component) return props.mode === "in" ? 0 : 1;
    return props.mode === "in"
      ? props.component.delay_percent
      : props.component.time_percent;
  };

  /** Updates the single semantic timing value for this component. */
  const updateSlider = (value: string) => {
    const fraction = Math.min(1, percentInputFraction(value));
    const neutral = props.mode === "in" ? 0 : 1;
    props.onChange(
      Math.abs(fraction - neutral) <= Number.EPSILON
        ? undefined
        : defaultTimingComponentForMode(props.mode, fraction),
    );
  };

  return (
    <div
      class="grid grid-cols-[130px_1fr_48px] items-center gap-3 text-sm"
      data-testid="color-path-timing-row"
      data-timing={props.label}
    >
      <span class="text-neutral-300">{props.label}</span>
      <input
        data-testid="color-path-timing-slider"
        class="accent-cyan-400 disabled:opacity-50"
        disabled={props.disabled}
        type="range"
        min="0"
        max="100"
        value={percentInputValue(sliderValue(), props.mode === "in" ? 0 : 1)}
        onInput={(event) => updateSlider(event.currentTarget.value)}
      />
      <span class="text-right font-mono text-neutral-400 text-xs">
        {percentInputValue(sliderValue(), props.mode === "in" ? 0 : 1)}%
      </span>
    </div>
  );
}

/** Builds a path-level timing component from a single semantic slider value. */
function defaultTimingComponentForMode(
  mode: "in" | "out",
  value: number,
): types.ColorPathTimingComponent {
  const fraction = Math.min(1, Math.max(0, value));
  if (mode === "in") {
    return {
      delay_percent: fraction,
      time_percent: 1 - fraction,
    };
  }
  return {
    delay_percent: 0,
    time_percent: fraction,
  };
}
