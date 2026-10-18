// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface MessageTypeStats {
  count: number;
  ratePerSec: number;
  avgDecodeMs: number;
  avgProcessMs: number;
  dropped: number;
}

export type MessageTypeRow = [string, MessageTypeStats];

/** Formats a User Timing measure name for compact display. */
export function formatMeasureName(name: string): string {
  return name.replace(/^nightfall:/, "");
}

/**
 * Orders message-type rows before any column sort: busiest types first, then
 * by name so equal rates keep a stable position between samples.
 */
export function compareMessageTypeRows(
  [leftType, leftStats]: MessageTypeRow,
  [rightType, rightStats]: MessageTypeRow,
): number {
  const rate = rightStats.ratePerSec - leftStats.ratePerSec;
  if (rate !== 0) return rate;
  return leftType.localeCompare(rightType);
}
