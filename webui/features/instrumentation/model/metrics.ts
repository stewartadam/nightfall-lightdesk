// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PerformanceMeasureUnit } from "../../../state/appStores";
export const TARGET_FPS = 44;
export const UI_TARGET_FPS = 60;
export const WEBSOCKET_DELIVERY_ONE_FRAME_MS = 22;
export const WEBSOCKET_DELIVERY_THREE_FRAMES_MS =
  WEBSOCKET_DELIVERY_ONE_FRAME_MS * 3;

/**
 * Semantic status of an instrumentation value. `default` is the plain value
 * color, `muted` marks a value that has not been sampled yet, and the rest
 * follow the shared Badge/Alert status tones.
 */
export type MetricTone = "default" | "muted" | "success" | "warning" | "danger";

/**
 * Grades a frame rate against its target: at least 95% of the target is
 * healthy, at least 80% is a warning, anything lower is a problem, and a
 * missing sample is muted.
 */
export function getFpsTone(
  fps: number | undefined,
  target = TARGET_FPS,
): MetricTone {
  if (fps === undefined) return "muted";
  if (fps >= target * 0.95) return "success";
  if (fps >= target * 0.8) return "warning";
  return "danger";
}

/**
 * Grades worker-to-main websocket delivery lag: within one backend frame is
 * healthy, within three frames is a warning, anything slower is a problem, and
 * a missing sample is muted.
 */
export function getDeliveryLagTone(lagMs: number | undefined): MetricTone {
  if (lagMs === undefined) return "muted";
  if (lagMs <= WEBSOCKET_DELIVERY_ONE_FRAME_MS) return "success";
  if (lagMs <= WEBSOCKET_DELIVERY_THREE_FRAMES_MS) return "warning";
  return "danger";
}

/** Formats a number with fixed decimals, or returns a placeholder */
export function formatNumber(
  value: unknown,
  decimals = 1,
  suffix = "",
): string {
  if (value === undefined || value === null) return "—";
  // Coerce strings or other types to number safely
  const n = typeof value === "number" ? value : Number(value as any);
  if (Number.isNaN(n)) return "—";
  return `${n.toFixed(decimals)}${suffix}`;
}

/** Formats timing and count samples with the unit attached to their aggregate. */
export function formatMeasureValue(
  value: unknown,
  unit: PerformanceMeasureUnit | undefined,
): string {
  return formatNumber(
    value,
    unit === "count" ? 0 : 2,
    unit === "count" ? "" : " ms",
  );
}

/** Collapsible section component */
