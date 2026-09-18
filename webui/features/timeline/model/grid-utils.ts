// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Grid snapping functionality for timeline
import { durationToMs, msToPixels, pixelsToMs } from "../../../lib/utils";
import type * as types from "../../../types";

/**
 * Calculate the duration in milliseconds for one beat at a given BPM
 */
export function msPerBeat(bpm: number): number {
  return Math.floor(60000 / bpm); // milliseconds per beat = (60 seconds * 1000) / BPM
}

/** Calculates the timeline duration for a whole-bar jump. */
export function msPerBars(
  bpm: number,
  beatsPerBar: number,
  bars: number,
): number {
  const beatDuration = msPerBeat(Math.max(1, bpm));
  const barBeats = Math.max(1, beatsPerBar);
  const barCount = Math.max(1, bars);
  return Math.round(beatDuration * barBeats * barCount);
}

/**
 * Calculate beats based on a time position and BPM
 */
function getBeatAtTime(ms: number, bpm: number): number {
  const beatDuration = msPerBeat(bpm);
  return Math.floor(ms / beatDuration);
}

/**
 * Calculate the beat number and bar number for a time position
 * Returns { beat: number, bar: number, beatInBar: number }
 */
export function getBeatInfo(
  ms: number,
  bpm: number,
  beatsPerBar = 4,
): {
  beat: number; // Total beat number
  bar: number; // Bar number (1-based)
  beatInBar: number; // Beat position within the current bar (0-based)
} {
  const totalBeat = getBeatAtTime(ms, bpm);
  const bar = Math.floor(totalBeat / beatsPerBar) + 1; // 1-based bar numbers
  const beatInBar = totalBeat % beatsPerBar; // 0-based beat in bar

  return {
    beat: totalBeat,
    bar,
    beatInBar,
  };
}

export interface SnapConfig {
  enabled: boolean;
  interval: number; // in milliseconds
  threshold: number; // snap threshold in pixels
  isBeat?: boolean; // Whether this snap interval is beat-based
  beatsPerBar?: number; // Number of beats per bar (for bar-level snapping)
  markers?: number[]; // Explicit marker positions in milliseconds
  anchorMs?: number; // Optional beat anchor offset in milliseconds
}

export interface SeekQuantizeConfig {
  snapEnabled: boolean;
  useBeatgrid: boolean;
  bpm: number;
  markers?: types.BeatMarker[];
}

export interface BarSeekQuantizeConfig {
  snapEnabled: boolean;
  useBeatgrid: boolean;
  bpm: number;
  beatsPerBar: number;
  markers?: types.BeatMarker[];
}

export interface TimelineSeekPositionConfig extends SeekQuantizeConfig {
  x: number;
  start: number;
  zoom: number;
}

const BAR_SEEK_EPSILON_MS = 0.001;

/**
 * Snap a position value to the nearest grid point if it's within the threshold
 */
export function snapToGrid(
  position: number, // in pixels
  zoom: number,
  startOffset: number, // in milliseconds
  config: SnapConfig,
): number {
  if (!config.enabled) return position;

  // Convert position to milliseconds
  const positionMs = startOffset + pixelsToMs(position, zoom);

  if (config.markers && config.markers.length > 0) {
    const thresholdMs = pixelsToMs(config.threshold, zoom);
    let nearestMarker = config.markers[0];
    let nearestDistance = Math.abs(positionMs - nearestMarker);

    for (let i = 1; i < config.markers.length; i++) {
      const markerMs = config.markers[i];
      const distance = Math.abs(positionMs - markerMs);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestMarker = markerMs;
      }
    }

    if (nearestDistance <= thresholdMs) {
      return msToPixels(nearestMarker - startOffset, zoom);
    }
    const lastMarker = config.markers[config.markers.length - 1];
    if (positionMs <= lastMarker || !config.isBeat || !config.beatsPerBar) {
      return position;
    }
  }

  // Calculate snapping points based on mode
  if (config.isBeat && config.beatsPerBar) {
    // In BPM mode, we want to snap to beats and bars
    const beatMs = config.interval;
    const barMs = beatMs * config.beatsPerBar;
    const anchorMs = config.anchorMs ?? 0;
    const relativeMs = positionMs - anchorMs;

    // First check if we're close to a bar boundary (higher priority)
    const nearestBarMs = anchorMs + Math.round(relativeMs / barMs) * barMs;
    const thresholdMs = pixelsToMs(config.threshold * 1.5, zoom); // Slightly higher threshold for bars

    if (Math.abs(positionMs - nearestBarMs) <= thresholdMs) {
      // Snap to bar boundary
      return msToPixels(nearestBarMs - startOffset, zoom);
    }

    // If not close to a bar boundary, try snapping to beat
    const nearestBeatMs = anchorMs + Math.round(relativeMs / beatMs) * beatMs;
    const beatThresholdMs = pixelsToMs(config.threshold, zoom);

    if (Math.abs(positionMs - nearestBeatMs) <= beatThresholdMs) {
      // Snap to beat
      return msToPixels(nearestBeatMs - startOffset, zoom);
    }

    // Not close enough to either
    return position;
  }
  // Regular time-based snapping
  const gridIntervalMs = config.interval;
  const nearestGridPointMs =
    Math.round(positionMs / gridIntervalMs) * gridIntervalMs;
  const thresholdMs = pixelsToMs(config.threshold, zoom);

  // If we're close enough to a grid point, snap to it
  if (Math.abs(positionMs - nearestGridPointMs) <= thresholdMs) {
    // Convert back to pixels
    return msToPixels(nearestGridPointMs - startOffset, zoom);
  }

  // Return the original position if no snapping occurs
  return position;
}
export function quantizeSeekPositionMs(
  positionMs: number,
  config: SeekQuantizeConfig,
): number {
  if (!config.snapEnabled || !config.useBeatgrid) {
    return positionMs;
  }

  const markerTimes = config.markers?.map((marker) =>
    durationToMs(marker.time),
  );
  if (markerTimes && markerTimes.length > 1) {
    const firstMarkerTime = markerTimes[0];
    if (positionMs < firstMarkerTime) {
      return positionMs;
    }

    let nearestTime = markerTimes[0];
    let nearestDistance = Math.abs(positionMs - nearestTime);
    for (let i = 1; i < markerTimes.length; i++) {
      const markerTime = markerTimes[i];
      const distance = Math.abs(positionMs - markerTime);
      if (distance < nearestDistance) {
        nearestTime = markerTime;
        nearestDistance = distance;
      }
    }

    const lastMarkerTime = markerTimes[markerTimes.length - 1];
    if (positionMs <= lastMarkerTime) {
      return nearestTime;
    }
  }

  const beatDuration = msPerBeat(config.bpm);
  if (!Number.isFinite(beatDuration) || beatDuration <= 0) {
    return positionMs;
  }

  const anchorMarker = config.markers?.[0];
  const anchorMs = anchorMarker ? durationToMs(anchorMarker.time) : 0;
  const anchorBeatIndex = anchorMarker?.beat_index ?? 0;
  const minBeatNumber = -anchorBeatIndex;
  const nearestBeatNumber = Math.round((positionMs - anchorMs) / beatDuration);
  if (nearestBeatNumber < minBeatNumber) {
    return positionMs;
  }

  return anchorMs + nearestBeatNumber * beatDuration;
}

/** Resolves a comma/period bar seek target with directional snap behavior. */
export function seekPositionByBars(
  positionMs: number,
  direction: -1 | 1,
  bars: number,
  config: BarSeekQuantizeConfig,
): number {
  const beatsPerBar = Math.max(1, config.beatsPerBar);
  const barCount = Math.max(1, bars);
  const barDuration = msPerBars(config.bpm, beatsPerBar, 1);
  const rawPosition = Math.max(
    0,
    positionMs + direction * barDuration * barCount,
  );
  if (
    !config.snapEnabled ||
    !Number.isFinite(barDuration) ||
    barDuration <= 0
  ) {
    return rawPosition;
  }

  const downbeatTimes = config.useBeatgrid
    ? [...(config.markers ?? [])]
        .filter((marker) => marker.is_downbeat)
        .map((marker) => durationToMs(marker.time))
        .sort((a, b) => a - b)
    : [];
  if (downbeatTimes.length > 1) {
    const snappedDownbeatIndex = findDirectionalSnapBoundaryIndex(
      downbeatTimes,
      positionMs,
      direction,
    );
    if (snappedDownbeatIndex !== undefined) {
      const snappedDownbeatMs = downbeatTimes[snappedDownbeatIndex];
      if (!isOnBarBoundary(positionMs, snappedDownbeatMs)) {
        return snappedDownbeatMs;
      }
      const targetIndex = snappedDownbeatIndex + direction * barCount;
      return resolveDownbeatTarget(downbeatTimes, targetIndex, barDuration);
    }
  }

  const anchorBarMs = resolveBarAnchorMs(config, barDuration);
  const snappedBoundaryIndex = directionalSnapBarBoundaryIndex(
    positionMs,
    anchorBarMs,
    barDuration,
    direction,
  );
  const snappedBoundaryMs = anchorBarMs + snappedBoundaryIndex * barDuration;
  if (!isOnBarBoundary(positionMs, snappedBoundaryMs)) {
    return Math.max(0, Math.round(snappedBoundaryMs));
  }
  const targetIndex = snappedBoundaryIndex + direction * barCount;
  return Math.max(0, Math.round(anchorBarMs + targetIndex * barDuration));
}

/** Finds the explicit downbeat marker reached by the directional snap phase. */
function findDirectionalSnapBoundaryIndex(
  downbeatTimes: number[],
  positionMs: number,
  direction: -1 | 1,
): number | undefined {
  if (direction < 0) {
    for (let index = downbeatTimes.length - 1; index >= 0; index -= 1) {
      const downbeatTime = downbeatTimes[index];
      if (downbeatTime <= positionMs + BAR_SEEK_EPSILON_MS) {
        return index;
      }
    }
    return undefined;
  }

  for (let index = 0; index < downbeatTimes.length; index += 1) {
    const downbeatTime = downbeatTimes[index];
    if (downbeatTime >= positionMs - BAR_SEEK_EPSILON_MS) {
      return index;
    }
  }
  return undefined;
}

/** Returns whether the playhead is already aligned to the snapped bar boundary. */
function isOnBarBoundary(positionMs: number, boundaryMs: number): boolean {
  return Math.abs(positionMs - boundaryMs) <= BAR_SEEK_EPSILON_MS;
}

/** Resolves a downbeat index, extrapolating outside known markers by BPM. */
function resolveDownbeatTarget(
  downbeatTimes: number[],
  targetIndex: number,
  barDuration: number,
): number {
  const lastIndex = downbeatTimes.length - 1;
  if (targetIndex < 0) {
    return Math.max(
      0,
      Math.round(downbeatTimes[0] + targetIndex * barDuration),
    );
  }
  if (targetIndex > lastIndex) {
    return Math.max(
      0,
      Math.round(
        downbeatTimes[lastIndex] + (targetIndex - lastIndex) * barDuration,
      ),
    );
  }
  return downbeatTimes[targetIndex];
}

/** Resolves the zero-index bar anchor for BPM-based boundary stepping. */
function resolveBarAnchorMs(
  config: BarSeekQuantizeConfig,
  barDuration: number,
): number {
  const beatsPerBar = Math.max(1, config.beatsPerBar);
  const beatDuration = barDuration / beatsPerBar;
  const anchorMarker = config.useBeatgrid ? config.markers?.[0] : undefined;
  const anchorMs = anchorMarker ? durationToMs(anchorMarker.time) : 0;
  const anchorBeatIndex = anchorMarker?.beat_index ?? 0;
  const beatOffsetInBar =
    ((anchorBeatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar;
  return anchorMs - beatOffsetInBar * beatDuration;
}

/** Resolves the bar boundary reached by the directional snap phase. */
function directionalSnapBarBoundaryIndex(
  positionMs: number,
  anchorBarMs: number,
  barDuration: number,
  direction: -1 | 1,
): number {
  const relativeBar = (positionMs - anchorBarMs) / barDuration;
  if (direction > 0) {
    return Math.ceil(relativeBar - BAR_SEEK_EPSILON_MS);
  }
  return Math.floor(relativeBar + BAR_SEEK_EPSILON_MS);
}

/**
 * Calculate beat grid visibility based on zoom level and BPM
 * Returns which beats should be visible at the current zoom level
 */
export function calculateBeatVisibility(
  zoom: number,
  bpm: number,
): {
  showDownbeats: boolean; // First beat of each bar
  showBeats: boolean; // Regular beats
  showSubdivisions: boolean; // Beat subdivisions (e.g., eighth notes)
  subdivisionCount: number; // How many subdivisions per beat
} {
  // Calculate beat duration in ms
  const beatDuration = msPerBeat(bpm);

  // Calculate pixels per beat at current zoom
  const pixelsPerBeat = (beatDuration * zoom) / 1000;

  // Default values
  const result = {
    showDownbeats: true,
    showBeats: true,
    showSubdivisions: false,
    subdivisionCount: 2,
  };

  // If beats are too close together (less than 20px apart), only show downbeats
  if (pixelsPerBeat < 20) {
    result.showBeats = false;
  }

  // If beats are far apart (more than 60px), show subdivisions
  if (pixelsPerBeat > 60) {
    result.showSubdivisions = true;

    // Calculate how many subdivisions to show based on zoom level
    if (pixelsPerBeat > 200) {
      result.subdivisionCount = 4; // Quarter notes
    } else {
      result.subdivisionCount = 2; // Eighth notes
    }
  }

  return result;
}

/**
 * Converts a timeline-local x-coordinate into the final seek position.
 * The position is always routed through seek quantization before callers seek.
 */
export function seekPositionFromTimelineX(
  params: TimelineSeekPositionConfig,
): number {
  const positionMs = params.start + pixelsToMs(params.x, params.zoom);
  return quantizeSeekPositionMs(positionMs, params);
}
