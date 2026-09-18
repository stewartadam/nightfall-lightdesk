// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

export type TrackingFlagId = "HTP" | "LTP" | "FX";

type ComposedTrackingFlags = {
  __Composed__: number;
};

type TrackingFlagOption = {
  id: TrackingFlagId;
  label: string;
  shortLabel: string;
  bit: number;
};

export const TRACKING_FLAG_OPTIONS: readonly TrackingFlagOption[] = [
  { id: "HTP", label: "Intensity", shortLabel: "HTP", bit: 1 },
  { id: "LTP", label: "Attributes", shortLabel: "LTP", bit: 2 },
  { id: "FX", label: "Effects", shortLabel: "FX", bit: 4 },
];

const TRACKING_FLAG_MASK = TRACKING_FLAG_OPTIONS.reduce(
  (mask, option) => mask | option.bit,
  0,
);

/**
 * Returns whether a value is the composed enum-flags payload serialized by Rust.
 */
function isComposedTrackingFlags(
  value: unknown,
): value is ComposedTrackingFlags {
  return (
    typeof value === "object" &&
    value !== null &&
    "__Composed__" in value &&
    typeof (value as ComposedTrackingFlags).__Composed__ === "number"
  );
}

/**
 * Converts a single tracking flag enum value into its bit-mask representation.
 */
function trackingFlagBit(flag: unknown): number {
  switch (flag) {
    case "HTP":
      return 1;
    case "LTP":
      return 2;
    case "FX":
      return 4;
    default:
      return 0;
  }
}

/**
 * Converts any supported tracking flag wire value into a normalized bit mask.
 */
export function trackingFlagsMask(flags: unknown): number {
  if (isComposedTrackingFlags(flags)) {
    return flags.__Composed__ & TRACKING_FLAG_MASK;
  }
  if (Array.isArray(flags)) {
    return flags.reduce((mask, flag) => mask | trackingFlagBit(flag), 0);
  }
  return trackingFlagBit(flags);
}

/**
 * Builds the Rust enum-flags composed wire value for a normalized tracking mask.
 */
export function trackingFlagsFromMask(
  mask: number,
): types.Cue["tracking_flags"] {
  return {
    __Composed__: mask & TRACKING_FLAG_MASK,
  } as unknown as types.Cue["tracking_flags"];
}

/**
 * Returns the operator-facing tracking flag ids represented by a normalized mask.
 */
export function trackingFlagIdsFromMask(mask: number): TrackingFlagId[] {
  return TRACKING_FLAG_OPTIONS.filter(
    (option) => (mask & option.bit) !== 0,
  ).map((option) => option.id);
}

/**
 * Returns the operator-facing tracking flag ids represented by any supported wire value.
 */
export function trackingFlagIds(flags: unknown): TrackingFlagId[] {
  return trackingFlagIdsFromMask(trackingFlagsMask(flags));
}

/**
 * Converts operator-facing tracking flag ids into a normalized bit mask.
 */
export function trackingFlagsMaskFromIds(flagIds: readonly string[]): number {
  const selected = new Set(flagIds);
  return TRACKING_FLAG_OPTIONS.reduce(
    (mask, option) => (selected.has(option.id) ? mask | option.bit : mask),
    0,
  );
}

/**
 * Builds the Rust enum-flags composed wire value from operator-facing flag ids.
 */
export function trackingFlagsFromIds(
  flagIds: readonly string[],
): types.Cue["tracking_flags"] {
  return trackingFlagsFromMask(trackingFlagsMaskFromIds(flagIds));
}

/**
 * Builds an explicit cue tracking mode from a tracking flag wire value.
 */
export function trackingModeFromFlags(
  flags: types.Cue["tracking_flags"],
): types.TrackingMode {
  return {
    type: "Flags",
    data: flags,
  };
}

/**
 * Returns the explicit flags for a tracking mode or a legacy fallback value.
 */
export function trackingFlagsForMode(
  mode: types.TrackingMode | undefined,
  fallback: types.Cue["tracking_flags"],
): types.Cue["tracking_flags"] {
  return mode?.type === "Flags" ? mode.data : fallback;
}

/**
 * Returns whether the requested tracking flag is enabled in a wire value.
 */
export function isTrackingFlagEnabled(
  flags: unknown,
  flagId: TrackingFlagId,
): boolean {
  const option = TRACKING_FLAG_OPTIONS.find((entry) => entry.id === flagId);
  return option ? (trackingFlagsMask(flags) & option.bit) !== 0 : false;
}

/**
 * Returns a new tracking flag value with one operator-facing flag toggled.
 */
export function setTrackingFlagEnabled(
  flags: unknown,
  flagId: TrackingFlagId,
  enabled: boolean,
): types.Cue["tracking_flags"] {
  const option = TRACKING_FLAG_OPTIONS.find((entry) => entry.id === flagId);
  if (!option) return trackingFlagsFromMask(trackingFlagsMask(flags));
  const currentMask = trackingFlagsMask(flags);
  const nextMask = enabled
    ? currentMask | option.bit
    : currentMask & ~option.bit;
  return trackingFlagsFromMask(nextMask);
}

/**
 * Formats a tracking mask using the operator-facing flag labels.
 */
export function trackingFlagsSummaryFromMask(mask: number): string {
  const labels = TRACKING_FLAG_OPTIONS.filter(
    (option) => (mask & option.bit) !== 0,
  ).map((option) => option.label);

  if (labels.length === 0) return "None";
  if (labels.length === TRACKING_FLAG_OPTIONS.length) return "All";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;

  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * Formats any supported tracking flag value using the operator-facing flag labels.
 */
export function trackingFlagsSummary(flags: unknown): string {
  return trackingFlagsSummaryFromMask(trackingFlagsMask(flags));
}

/**
 * Formats operator-facing tracking flag ids using the user-visible labels.
 */
export function trackingFlagsSummaryFromIds(
  flagIds: readonly string[],
): string {
  return trackingFlagsSummaryFromMask(trackingFlagsMaskFromIds(flagIds));
}
