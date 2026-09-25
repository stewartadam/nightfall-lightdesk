// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { DmxIoMode, type OutboundDmxUniverse } from "../types";

/**
 * `transport` label of output universes reported in console space (console numbering);
 * other output labels name a transport family using on-the-wire numbering.
 */
export const CONSOLE_TRANSPORT = "Console";

type InputFreshnessDot = "live" | "stale" | "unknown";

export interface InputFreshnessView {
  dot: InputFreshnessDot;
  badgeLabel?: "Live" | "Stale";
  ageLabel?: string;
}

export function formatFrameAgeMs(value?: number): string {
  if (value === undefined) return "unknown";
  if (value < 1000) {
    return `${value} ms`;
  }
  if (value < 60_000) {
    const seconds = value / 1000;
    return `${seconds.toFixed(1).replace(/\.0$/, "")} s`;
  }
  const minutes = Math.floor(value / 60_000);
  const remainingSeconds = Math.floor((value % 60_000) / 1000);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Normalizes websocket DMX universe payloads while preserving freshness metadata.
 * This allows tests to assert that freshness fields survive message handling.
 */
export function normalizeDmxUniverseData(
  data: OutboundDmxUniverse[],
): OutboundDmxUniverse[] {
  return data.map((universe) => ({
    universe_id: universe.universe_id,
    channels: universe.channels,
    io_mode: universe.io_mode,
    transport: universe.transport,
    frame_age_ms: universe.frame_age_ms,
    is_stale: universe.is_stale,
    is_self: universe.is_self,
  }));
}

export function getInputFreshness(
  universe: OutboundDmxUniverse,
): InputFreshnessView {
  if (universe.io_mode !== DmxIoMode.Input) {
    return { dot: "unknown" };
  }

  if (universe.is_stale === true) {
    return {
      dot: "stale",
      badgeLabel: "Stale",
      ageLabel: formatFrameAgeMs(universe.frame_age_ms),
    };
  }

  if (universe.is_stale === false) {
    return {
      dot: "live",
      badgeLabel: "Live",
      ageLabel: formatFrameAgeMs(universe.frame_age_ms),
    };
  }

  return { dot: "unknown" };
}
