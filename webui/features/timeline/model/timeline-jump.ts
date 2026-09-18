// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { durationToMs } from "../../../lib/utils";
import type * as types from "../../../types";
import { msPerBeat } from "./grid-utils";

export type TimelineJumpConfig = {
  bpm: number;
  beatsPerBar: number;
  markers?: readonly types.BeatMarker[];
};

export type TimelineJumpOptions = {
  includeBareNumericBeat?: boolean;
};

export type TimelineBeatPosition = {
  bar: number;
  beat: number;
};

export type TimelineJumpTarget =
  | {
      kind: "timestamp";
      positionMs: number;
      label: string;
      typeLabel: "Timestamp";
      beatPosition: TimelineBeatPosition;
    }
  | {
      kind: "beat";
      positionMs: number;
      label: string;
      typeLabel: "Beat";
      beatPosition: TimelineBeatPosition;
    };

/** Formats a timeline millisecond position as a compact human timestamp. */
export function formatTimelineTimestamp(positionMs: number): string {
  const clampedMs = Math.max(0, Math.round(positionMs));
  const milliseconds = clampedMs % 1000;
  const totalSeconds = Math.floor(clampedMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const suffix = milliseconds
    ? `.${milliseconds.toString().padStart(3, "0")}`
    : "";

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}${suffix}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}${suffix}`;
}

/** Formats a one-based bar and beat position for timeline jump display. */
export function formatTimelineBeatPosition(position: TimelineBeatPosition) {
  return `${position.bar}:${position.beat.toString().padStart(2, "0")}`;
}

/** Resolves the visible beatgrid position for a timeline millisecond value. */
export function beatPositionAtMs(
  positionMs: number,
  config: TimelineJumpConfig,
): TimelineBeatPosition {
  const beatsPerBar = Math.max(1, config.beatsPerBar);
  const beatDuration = msPerBeat(Math.max(1, config.bpm));
  const sortedMarkers = sortedBeatMarkers(config.markers);
  let totalBeat = Math.floor(Math.max(0, positionMs) / beatDuration);

  if (sortedMarkers.length > 0) {
    let anchorBeat = sortedMarkers[0].beat_index;
    let anchorMs = durationToMs(sortedMarkers[0].time);

    for (const marker of sortedMarkers) {
      const markerMs = durationToMs(marker.time);
      if (markerMs > positionMs) break;
      anchorBeat = marker.beat_index;
      anchorMs = markerMs;
    }

    totalBeat = Math.max(
      0,
      anchorBeat + Math.floor((positionMs - anchorMs) / beatDuration),
    );
  }

  return {
    bar: Math.floor(totalBeat / beatsPerBar) + 1,
    beat: (totalBeat % beatsPerBar) + 1,
  };
}

/** Resolves a one-based bar and beat position to timeline milliseconds. */
export function positionMsForBeatPosition(
  position: TimelineBeatPosition,
  config: TimelineJumpConfig,
): number | undefined {
  const beatsPerBar = Math.max(1, config.beatsPerBar);
  if (
    !Number.isInteger(position.bar) ||
    !Number.isInteger(position.beat) ||
    position.bar < 1 ||
    position.beat < 1 ||
    position.beat > beatsPerBar
  ) {
    return undefined;
  }

  const beatDuration = msPerBeat(Math.max(1, config.bpm));
  const targetBeat = (position.bar - 1) * beatsPerBar + (position.beat - 1);
  const sortedMarkers = sortedBeatMarkers(config.markers);
  const anchor =
    findNearestBeatAnchor(sortedMarkers, targetBeat) ?? sortedMarkers[0];

  if (!anchor) {
    return Math.round(targetBeat * beatDuration);
  }

  return Math.max(
    0,
    Math.round(
      durationToMs(anchor.time) +
        (targetBeat - anchor.beat_index) * beatDuration,
    ),
  );
}

/** Parses a popover query into every direct timeline jump target it can represent. */
export function resolveTimelineJumpTargets(
  input: string,
  config: TimelineJumpConfig,
  options: TimelineJumpOptions = {},
): TimelineJumpTarget[] {
  const query = input.trim();
  if (!query) return [];
  const targets: TimelineJumpTarget[] = [];

  const prefixedAbsoluteBeat = parsePrefixedAbsoluteBeatJumpInput(query);
  if (prefixedAbsoluteBeat) {
    const target = absoluteBeatJumpTarget(prefixedAbsoluteBeat, config);
    return target ? [target] : [];
  }

  const beatPosition = parseBeatJumpInput(query);
  if (beatPosition) {
    const target = beatJumpTarget(beatPosition, config);
    return target ? [target] : [];
  }

  const timestampSource = timestampInputSource(query);
  if (timestampSource !== undefined) {
    const timestampPositionMs = parseTimestampMs(timestampSource);
    if (timestampPositionMs !== undefined) {
      targets.push({
        kind: "timestamp",
        positionMs: timestampPositionMs,
        label: `Jump to time ${formatTimelineTimestamp(timestampPositionMs)}`,
        typeLabel: "Timestamp",
        beatPosition: beatPositionAtMs(timestampPositionMs, config),
      });
    }
  }

  const bareBeatPosition = parseBareBeatJumpInput(query);
  const bareBeatTarget = bareBeatPosition
    ? beatJumpTarget(bareBeatPosition, config)
    : undefined;
  if (bareBeatTarget) {
    targets.push(bareBeatTarget);
  }

  const bareNumericBeat = options.includeBareNumericBeat
    ? parseBareAbsoluteBeatJumpInput(query)
    : undefined;
  const bareNumericBeatTarget = bareNumericBeat
    ? absoluteBeatJumpTarget(bareNumericBeat, config)
    : undefined;
  if (bareNumericBeatTarget) {
    targets.push(bareNumericBeatTarget);
  }

  return targets;
}

/** Parses a popover query into its first direct timeline jump target when possible. */
export function resolveTimelineJumpTarget(
  input: string,
  config: TimelineJumpConfig,
): TimelineJumpTarget | undefined {
  return resolveTimelineJumpTargets(input, config)[0];
}

/** Builds a direct beat jump row when the requested bar-beat position is valid. */
function beatJumpTarget(
  beatPosition: TimelineBeatPosition,
  config: TimelineJumpConfig,
): TimelineJumpTarget | undefined {
  const positionMs = positionMsForBeatPosition(beatPosition, config);
  if (positionMs === undefined) return undefined;

  return {
    kind: "beat",
    positionMs,
    label: `Jump to Beat ${formatTimelineBeatPosition(beatPosition)}`,
    typeLabel: "Beat",
    beatPosition,
  };
}

/** Builds a direct beat jump row from a one-based absolute beat number. */
function absoluteBeatJumpTarget(
  absoluteBeat: number,
  config: TimelineJumpConfig,
): TimelineJumpTarget | undefined {
  const beatPosition = beatPositionForAbsoluteBeat(absoluteBeat, config);
  if (!beatPosition) return undefined;

  const positionMs = positionMsForBeatPosition(beatPosition, config);
  if (positionMs === undefined) return undefined;

  return {
    kind: "beat",
    positionMs,
    label: `Jump to Beat ${absoluteBeat}`,
    typeLabel: "Beat",
    beatPosition,
  };
}

/** Converts a one-based absolute beat number into the current meter coordinates. */
function beatPositionForAbsoluteBeat(
  absoluteBeat: number,
  config: TimelineJumpConfig,
): TimelineBeatPosition | undefined {
  if (!Number.isInteger(absoluteBeat) || absoluteBeat < 1) return undefined;

  const beatsPerBar = Math.max(1, config.beatsPerBar);
  const beatIndex = absoluteBeat - 1;
  return {
    bar: Math.floor(beatIndex / beatsPerBar) + 1,
    beat: (beatIndex % beatsPerBar) + 1,
  };
}

/** Parses an unprefixed bar-beat query such as `45:04` into one-based coordinates. */
function parseBareBeatJumpInput(
  query: string,
): TimelineBeatPosition | undefined {
  const match = /^(\d+)\s*[:.]\s*(\d+)$/.exec(query);
  if (!match) return undefined;

  const bar = Number.parseInt(match[1] ?? "", 10);
  const beat = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(bar) || !Number.isFinite(beat)) return undefined;
  return { bar, beat };
}

/** Returns an explicit timestamp source from prefixed timestamp queries only. */
function prefixedTimestampInputSource(query: string): string | undefined {
  const prefixed = /^t(?:ime)?\s+(.+)$/i.exec(query);
  return prefixed?.[1]?.trim();
}

/** Returns whether a query explicitly asks for a beat interpretation. */
function isPrefixedBeatJumpInput(query: string): boolean {
  return /^b(?:eat|ar)?\s+/i.test(query);
}

/** Extracts a timestamp body from prefixed or colon-shaped jump queries. */
function timestampInputSource(query: string): string | undefined {
  if (isPrefixedBeatJumpInput(query)) return undefined;
  const prefixed = prefixedTimestampInputSource(query);
  if (prefixed) return prefixed;
  if (query.includes(":")) return query;
  return undefined;
}

/** Parses a bar-beat query such as `b 45:04` into one-based coordinates. */
function parseBeatJumpInput(query: string): TimelineBeatPosition | undefined {
  const match = /^b(?:eat|ar)?\s+(\d+)\s*[:.]\s*(\d+)$/i.exec(query);
  if (!match) return undefined;

  const bar = Number.parseInt(match[1] ?? "", 10);
  const beat = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(bar) || !Number.isFinite(beat)) return undefined;
  return { bar, beat };
}

/** Parses a prefixed absolute beat query such as `b 64`. */
function parsePrefixedAbsoluteBeatJumpInput(query: string): number | undefined {
  const match = /^b(?:eat)?\s+(\d+)$/i.exec(query);
  if (!match) return undefined;

  const absoluteBeat = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(absoluteBeat)) return undefined;
  return absoluteBeat;
}

/** Parses an unprefixed absolute beat query such as `64`. */
function parseBareAbsoluteBeatJumpInput(query: string): number | undefined {
  const match = /^(\d+)$/.exec(query);
  if (!match) return undefined;

  const absoluteBeat = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(absoluteBeat)) return undefined;
  return absoluteBeat;
}

/** Returns beat markers sorted by timeline time and beat index. */
function sortedBeatMarkers(markers: readonly types.BeatMarker[] | undefined) {
  return [...(markers ?? [])].sort((left, right) => {
    const leftMs = durationToMs(left.time);
    const rightMs = durationToMs(right.time);
    return leftMs - rightMs || left.beat_index - right.beat_index;
  });
}

/** Finds the nearest explicit beat marker at or before the target beat index. */
function findNearestBeatAnchor(
  markers: readonly types.BeatMarker[],
  targetBeat: number,
) {
  let anchor: types.BeatMarker | undefined;
  for (const marker of markers) {
    if (marker.beat_index > targetBeat) break;
    anchor = marker;
  }
  return anchor;
}

/** Parses seconds, minutes:seconds, or hours:minutes:seconds into milliseconds. */
function parseTimestampMs(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.round(Number.parseFloat(trimmed) * 1000);
  }

  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;

  if (!parts.every(isTimestampPart)) return undefined;

  const numericParts = parts.map((part) => Number.parseFloat(part));
  if (numericParts.some((part) => !Number.isFinite(part) || part < 0)) {
    return undefined;
  }

  const seconds = numericParts[numericParts.length - 1] ?? 0;
  const minutes = numericParts[numericParts.length - 2] ?? 0;
  const hours = parts.length === 3 ? (numericParts[0] ?? 0) : 0;
  if (seconds >= 60 || minutes >= 60) return undefined;

  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

/** Returns whether a timestamp part is an unsigned integer, except seconds may be fractional. */
function isTimestampPart(part: string, index: number, parts: string[]) {
  const isSecondsPart = index === parts.length - 1;
  return isSecondsPart ? /^\d+(?:\.\d+)?$/.test(part) : /^\d+$/.test(part);
}
