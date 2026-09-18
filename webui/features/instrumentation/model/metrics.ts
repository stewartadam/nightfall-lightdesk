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

/** Returns a color class based on FPS performance */
export function getFpsColor(
  fps: number | undefined,
  target = TARGET_FPS,
): string {
  if (fps === undefined) return "text-gray-400";
  if (fps >= target * 0.95) return "text-green-500";
  if (fps >= target * 0.8) return "text-yellow-500";
  return "text-red-500";
}

/** Returns a color class for worker-to-main websocket delivery lag. */
export function getDeliveryLagColor(lagMs: number | undefined): string {
  if (lagMs === undefined) return "text-gray-400";
  if (lagMs <= WEBSOCKET_DELIVERY_ONE_FRAME_MS) return "text-green-500";
  if (lagMs <= WEBSOCKET_DELIVERY_THREE_FRAMES_MS) return "text-yellow-500";
  return "text-red-500";
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
