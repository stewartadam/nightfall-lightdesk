// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Timeline } from "../../../types";

/** Normalizes UUID-shaped identifiers for stable store and panel comparisons. */
export function normalizeTimelineUid(uid: unknown): string {
  return String(uid).replace(/-/g, "").toLowerCase();
}

/** Sorts stored timelines by their user-facing numeric identifier. */
export function buildTimelineList(
  timelineMap: Readonly<Record<string, Timeline>>,
): Timeline[] {
  return Object.values(timelineMap).sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  );
}

/** Indexes timelines by normalized UID for selection and reveal requests. */
export function indexTimelinesByUid(
  timelineList: readonly Timeline[],
): Map<string, Timeline> {
  return new Map(
    timelineList.map((timeline) => [
      normalizeTimelineUid(timeline.identifiers.uid),
      timeline,
    ]),
  );
}

/** Computes the first positive timeline identifier not already in use. */
export function nextTimelineId(timelineList: readonly Timeline[]): number {
  const existingIds = new Set(
    timelineList.map((timeline) => timeline.identifiers.id),
  );
  let id = 1;
  while (existingIds.has(id)) id++;
  return id;
}

/** Formats a timeline audio path for compact list and card presentation. */
export function timelineAudioLabel(timeline: Timeline): string {
  return timeline.audio_path
    ? (timeline.audio_path.split("/").pop() ?? timeline.audio_path)
    : "No audio";
}

/** Reports whether no other timeline references the candidate timecode. */
export function timelineExclusivelyOwnsTimecode(
  timelineList: readonly Timeline[],
  timeline: Timeline,
): boolean {
  return (
    timelineList.filter(
      (candidate) => candidate.timecode_uid === timeline.timecode_uid,
    ).length === 1
  );
}
