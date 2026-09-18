// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { persistentAtom } from "@nanostores/persistent";
import { isAsciiTapKey } from "../model/panel-model";
import {
  DEFAULT_TAP_PATTERN_DETECTION_OPTIONS,
  normalizeTapPatternDetectionOptions,
  type TapEvent,
  type TapPatternDetectionOptions,
} from "../model/tap-pattern-analysis";

export interface StoredTapPatternState {
  taps: TapEvent[];
  detectionOptions: TapPatternDetectionOptions;
}

const EMPTY_TAP_PATTERN_STATE: StoredTapPatternState = {
  taps: [],
  detectionOptions: DEFAULT_TAP_PATTERN_DETECTION_OPTIONS,
};

/** Returns true when a value looks like a persisted tap event. */
function isStoredTap(value: unknown): value is TapEvent {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Partial<TapEvent>;
  const validStoredKey =
    candidate.key == null ||
    (typeof candidate.key === "string" && isAsciiTapKey(candidate.key));
  return (
    typeof candidate.id === "number" &&
    Number.isFinite(candidate.id) &&
    typeof candidate.timeMs === "number" &&
    Number.isFinite(candidate.timeMs) &&
    candidate.timeMs >= 0 &&
    validStoredKey
  );
}

/** Returns true when a value looks like persisted tap detection options. */
function isStoredDetectionOptions(
  value: unknown,
): value is Partial<TapPatternDetectionOptions> {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Partial<TapPatternDetectionOptions>;
  return (
    (candidate.sensitivity == null ||
      (typeof candidate.sensitivity === "number" &&
        Number.isFinite(candidate.sensitivity))) &&
    (candidate.granularity == null ||
      (typeof candidate.granularity === "number" &&
        Number.isFinite(candidate.granularity)))
  );
}

/** Sanitizes a persisted tap-pattern state object. */
export function sanitizeStoredTapState(value: unknown): StoredTapPatternState {
  if (value === null || typeof value !== "object") {
    return EMPTY_TAP_PATTERN_STATE;
  }
  const parsed = value as Partial<StoredTapPatternState>;
  if (!Array.isArray(parsed.taps)) return EMPTY_TAP_PATTERN_STATE;
  return {
    taps: parsed.taps
      .filter(isStoredTap)
      .sort((left, right) => left.timeMs - right.timeMs)
      .map((tap, index) => ({
        id: index + 1,
        timeMs: tap.timeMs,
        ...(tap.key ? { key: tap.key } : {}),
      })),
    detectionOptions: normalizeTapPatternDetectionOptions(
      isStoredDetectionOptions(parsed.detectionOptions)
        ? parsed.detectionOptions
        : DEFAULT_TAP_PATTERN_DETECTION_OPTIONS,
    ),
  };
}

/** Decodes persisted tap-pattern state from localStorage. */
export function decodeTapPatternState(value: string): StoredTapPatternState {
  try {
    return sanitizeStoredTapState(JSON.parse(value));
  } catch {
    return EMPTY_TAP_PATTERN_STATE;
  }
}

export const tapPatternState = persistentAtom<StoredTapPatternState>(
  "nightfall-tap-pattern-panel:taps",
  EMPTY_TAP_PATTERN_STATE,
  { decode: decodeTapPatternState, encode: JSON.stringify },
);
