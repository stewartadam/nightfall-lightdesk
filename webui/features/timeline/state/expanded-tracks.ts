// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { bestEffortPersistentAtom } from "../../../lib/best-effort-persistent-atom";
import { getLogger } from "../../../lib/logger";

const log = getLogger(import.meta.url);
const STORAGE_KEY = "nightfall-timeline-expanded-tracks";

/** Decodes the persisted list of expanded track IDs, dropping malformed entries. */
export function decodeExpandedTracks(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * IDs of the timeline tracks whose automation lanes this browser shows expanded. Expanding is
 * a view choice, so it stays on this device instead of being saved with the show.
 */
export const expandedTimelineTracks = bestEffortPersistentAtom<string[]>(
  STORAGE_KEY,
  [],
  {
    decode: decodeExpandedTracks,
    encode: JSON.stringify,
    onSetError: (error) =>
      log.warn("Failed to persist expanded timeline tracks", error),
  },
);

/** Shows or hides one track's automation lanes on this device. */
export function setTrackExpanded(trackId: string, expanded: boolean): void {
  const current = expandedTimelineTracks.get();
  if (current.includes(trackId) === expanded) return;
  expandedTimelineTracks.set(
    expanded
      ? [...current, trackId]
      : current.filter((existing) => existing !== trackId),
  );
}
