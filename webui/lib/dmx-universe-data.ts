// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  DmxIoMode,
  type DmxUniverseChannels,
  type DmxUniverseKey,
  type DmxUniverseSummary,
} from "../types";

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

/** One listed universe together with the channel values the backend sent for it. */
export type DmxUniverseSnapshot = DmxUniverseSummary & {
  /** Channel values starting at address 1; `null` until the backend sent them. */
  channels: (number | null)[];
  /** Milliseconds since an input universe last received a frame. */
  frame_age_ms?: number;
};

/** Returns the identity of a universe within its I/O mode and numbering space. */
export function dmxUniverseKeyOf(universe: DmxUniverseKey): DmxUniverseKey {
  return {
    universe_id: universe.universe_id,
    io_mode: universe.io_mode,
    transport: universe.transport,
  };
}

/** Returns a string that is equal for two universes exactly when their keys are equal. */
export function dmxUniverseKeyId(universe: DmxUniverseKey): string {
  return `${universe.io_mode}|${universe.transport}|${universe.universe_id}`;
}

/** Channels in one DMX universe. */
export const DMX_UNIVERSE_CHANNELS = 512;

/**
 * Combines a listed universe with its channel values from the latest `DmxUniverseChannels`
 * message. Until the backend has sent values for that universe, every channel is `null`, so the
 * grid can be drawn at once and fill in when the values arrive.
 */
export function dmxUniverseSnapshot(
  summary: DmxUniverseSummary,
  channelMessages: readonly DmxUniverseChannels[],
): DmxUniverseSnapshot {
  const id = dmxUniverseKeyId(summary);
  const values = channelMessages.find(
    (universe) => dmxUniverseKeyId(universe) === id,
  );
  if (!values) {
    return {
      ...summary,
      channels: new Array<null>(DMX_UNIVERSE_CHANNELS).fill(null),
      frame_age_ms: undefined,
    };
  }
  return {
    ...summary,
    channels: Array.from(values.channels),
    frame_age_ms: values.frame_age_ms,
  };
}

/** Freshness fields of an input universe, as listed or with its channel values. */
type InputFreshnessSource = Pick<DmxUniverseSummary, "io_mode" | "is_stale"> & {
  frame_age_ms?: number;
};

/** Projects an input universe's freshness into the panel's dot, badge and age label. */
export function getInputFreshness(
  universe: InputFreshnessSource,
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
