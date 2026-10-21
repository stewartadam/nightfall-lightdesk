// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Timecode,
  TimecodeSignal,
  TimecodeSource,
  type TimecodeState,
} from "../../types";

/** How a status pill is colored: green while running, amber while signal is missing. */
export type TimecodeStatusTone = "running" | "warning" | "idle";

/** A timecode's run state as shown in status pills. */
export interface TimecodeStatus {
  label: string;
  tone: TimecodeStatusTone;
}

const SOURCE_LABELS: Record<TimecodeSource, string> = {
  [TimecodeSource.Internal]: "Internal",
  [TimecodeSource.MidiMtc]: "MIDI timecode",
  [TimecodeSource.SmpteLtc]: "LTC",
  [TimecodeSource.ArtNet]: "Art-Net",
};

/** Formats a rate enum value such as `Fps29_97` as "29.97 fps". */
export function timecodeRateLabel(rate: string): string {
  return `${rate.replace("Fps", "").replace("_", ".")} fps`;
}

/**
 * Names a timecode's source, noting the rate an external source actually
 * sends when it differs from the timecode's configured rate.
 */
export function timecodeSourceLabel(
  timecode: Timecode,
  state: TimecodeState | undefined,
): string {
  const label = SOURCE_LABELS[timecode.source] ?? String(timecode.source);
  const sourceRate = state?.source_rate;
  return sourceRate && sourceRate !== timecode.rate
    ? `${label} (sends ${timecodeRateLabel(sourceRate)})`
    : label;
}

/**
 * Describes whether a timecode is running and, for an external source,
 * whether its signal is arriving.
 */
export function timecodeStatus(state: TimecodeState): TimecodeStatus {
  switch (state.signal) {
    case TimecodeSignal.Waiting:
      return { label: "No signal", tone: "warning" };
    case TimecodeSignal.Receiving:
      return { label: "Receiving", tone: "running" };
    case TimecodeSignal.Freewheeling:
      return { label: "Freewheel", tone: "warning" };
    case TimecodeSignal.Off:
      return { label: "Idle", tone: "idle" };
    default:
      return state.is_active
        ? { label: "Running", tone: "running" }
        : { label: "Idle", tone: "idle" };
  }
}

/** Tailwind classes for a status pill of the given tone. */
export function timecodeStatusPillClass(tone: TimecodeStatusTone): string {
  switch (tone) {
    case "running":
      return "bg-emerald-500/20 text-emerald-200 ring-emerald-400/30";
    case "warning":
      return "bg-amber-500/20 text-amber-200 ring-amber-400/30";
    default:
      return "bg-neutral-700/40 text-neutral-300 ring-neutral-600";
  }
}
