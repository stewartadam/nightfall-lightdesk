// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { TempoSnapshot } from "../../types";

/** Largest bar length drawn as individual beat dots; longer bars show a counter. */
export const MAX_BEAT_DOTS = 8;

/**
 * Extrapolates the engine's beat counter to `nowMs` from the last received
 * snapshot, so the beat indicator animates between engine messages.
 */
export function extrapolateBeatPosition(
  snapshot: TempoSnapshot,
  receivedAtMs: number,
  nowMs: number,
): number {
  const elapsedMs = Math.max(0, nowMs - receivedAtMs);
  return snapshot.beat_position + (elapsedMs / 60_000) * snapshot.bpm;
}

/** Returns the zero-based beat within the bar for a beat counter position. */
export function beatInBar(beatPosition: number, beatsPerBar: number): number {
  const bar = Math.max(1, Math.floor(beatsPerBar));
  return ((Math.floor(beatPosition) % bar) + bar) % bar;
}

/** Formats a tempo for compact display, with one decimal only when it matters. */
export function formatBpm(bpm: number): string {
  const rounded = Math.round(bpm * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

/**
 * Parses an operator-entered tempo, returning `undefined` for anything that is
 * not a positive finite number.
 */
export function parseBpmInput(value: string): number | undefined {
  const parsed = Number(value.trim());
  return value.trim() !== "" && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : undefined;
}
