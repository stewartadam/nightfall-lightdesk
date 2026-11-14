// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createRoot, createSignal } from "solid-js";
import { createTimelineEventEffect } from "../../features/timeline/services/timeline-event-effect";
import type * as types from "../../types";

/** Builds a minimal timeline store entry carrying only the ID the effect sends to. */
const timelineWithId = (id: number) =>
  ({ identifiers: { id } }) as unknown as types.Timeline;

/**
 * Runs the production timeline event effect against a fake event signal and timeline store
 * entry, applies `steps` in order, and returns the timeline ID and event value of each send.
 */
function recordSends(
  initial: types.Timeline | undefined,
  steps: (
    fire: (value: number) => void,
    setTimeline: (timeline: types.Timeline | undefined) => void,
  ) => void,
): string[] {
  const sends: string[] = [];
  const [event, setEvent] = createSignal<{ value: number }>();
  const [timeline, setTimeline] = createSignal<types.Timeline | undefined>(
    initial,
  );
  const dispose = createRoot((cleanup) => {
    createTimelineEventEffect(event, timeline, (sent, target) => {
      sends.push(`${target.identifiers.id}:${sent.value}`);
    });
    return cleanup;
  });
  steps((value) => setEvent({ value }), setTimeline);
  dispose();
  return sends;
}

/** Fires one event, then replaces and re-adds the timeline entry as a resync would, then fires another. */
export function replaceTimelineAfterOneEvent(): string[] {
  return recordSends(timelineWithId(1), (fire, setTimeline) => {
    fire(10);
    setTimeline(timelineWithId(2));
    setTimeline(undefined);
    setTimeline(timelineWithId(3));
    fire(20);
  });
}

/** Fires an event before the timeline reaches the store, then delivers the timeline and replaces it. */
export function eventBeforeTimelineLoads(): string[] {
  return recordSends(undefined, (fire, setTimeline) => {
    fire(10);
    setTimeline(timelineWithId(1));
    setTimeline(timelineWithId(2));
  });
}
