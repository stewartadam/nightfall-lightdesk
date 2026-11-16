// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Color path previews sampled by the engine through the WASM bridge, so the editor shows the
 * same interpolation, curves, timing and midpoint brightness that cue playback outputs. The
 * pure color math these previews project with lives in `color-path-preview.ts`.
 */

import { createSignal } from "solid-js";
import type * as types from "../types";
import { ColorInterpolationSpace } from "../types";
import {
  type ColorPathRoutePoint,
  cieChromaticityToPreviewPoint,
  e154RgbToCieChromaticity,
  resolvedInterpolationSpace,
} from "./color-path-preview";
import { getLogger } from "./logger";
import { loadedWasmBridge, loadWasmBridge } from "./wasm-module";

const log = getLogger(import.meta.url);

/** Where loading the sampler stands; a failed load is not retried until the page reloads. */
type SamplerState = "idle" | "loading" | "ready" | "failed";

/** Reactive sampler state, so previews computed before the bridge loaded re-run once it has. */
const [samplerState, setSamplerState] = createSignal<SamplerState>("idle");

/**
 * Loads the WASM bridge that samples color paths. Previews render nothing until it resolves,
 * then update reactively. A failed load is logged once and leaves previews empty.
 */
export async function loadColorPathSampling(): Promise<void> {
  if (samplerState() === "ready" || loadedWasmBridge()) {
    setSamplerState("ready");
    return;
  }
  setSamplerState("loading");
  try {
    await loadWasmBridge();
    setSamplerState("ready");
  } catch (error) {
    setSamplerState("failed");
    log.error("Failed to load the color path sampler", { error });
    throw error;
  }
}

/** Returns the loaded bridge, starting a load on first use; tracks the sampler state reactively. */
function samplerBridge() {
  const state = samplerState();
  const wasm = loadedWasmBridge();
  if (wasm) return wasm;
  if (state === "idle") {
    loadColorPathSampling().catch(() => {});
  }
  return null;
}

/**
 * Builds `count` (at least two) evenly spaced preview colors for swatches and route overlays,
 * with the authored anchors kept exact. Returns an empty list while the bridge loads (or after
 * it failed); reading this inside a Solid computation re-runs it once the bridge is ready.
 */
export function colorPathSamples(
  path: types.ColorPath,
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
  count: number,
): types.ColorPathRgb[] {
  const wasm = samplerBridge();
  if (!wasm) return [];
  try {
    return wasm.color_path_samples(
      path,
      start,
      end,
      Math.max(2, Math.floor(count)),
    ) as types.ColorPathRgb[];
  } catch (error) {
    log.warn("Color path could not be sampled", { error });
    return [];
  }
}

/** Interpolates two numeric values by the given normalized ratio. */
function lerp(start: number, end: number, ratio: number): number {
  return start + (end - start) * ratio;
}

/**
 * Projects preview samples into PLASA ANSI E1.54 CIE xy chromaticity coordinates. RGB paths are
 * drawn as the straight line between their anchors, since additive mixing moves in a straight
 * line in chromaticity space; other spaces follow each sampled color.
 */
export function colorPathRoutePoints(
  path: types.ColorPath,
  start: types.ColorPathRgb,
  end: types.ColorPathRgb,
  count: number,
): ColorPathRoutePoint[] {
  const samples = colorPathSamples(path, start, end, count);
  /** Returns the normalized path progress of the sample at `index`. */
  const progressAt = (index: number) =>
    samples.length <= 1 ? 0 : index / (samples.length - 1);

  if (resolvedInterpolationSpace(path) === ColorInterpolationSpace.Rgb) {
    const startPoint = cieChromaticityToPreviewPoint(
      e154RgbToCieChromaticity(start),
    );
    const endPoint = cieChromaticityToPreviewPoint(
      e154RgbToCieChromaticity(end),
    );
    return samples.map((color, index) => {
      const progress = progressAt(index);
      return {
        color,
        x: lerp(startPoint.x, endPoint.x, progress),
        y: lerp(startPoint.y, endPoint.y, progress),
        progress,
      };
    });
  }

  return samples.map((color, index) => {
    const point = cieChromaticityToPreviewPoint(
      e154RgbToCieChromaticity(color),
    );
    return { color, x: point.x, y: point.y, progress: progressAt(index) };
  });
}
