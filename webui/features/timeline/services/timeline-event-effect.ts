// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createEffect, on, untrack } from "solid-js";
import type * as types from "../../../types";

/**
 * Sends a backend command once for each timeline UI event. A resync or reload that replaces
 * the timeline's store entry never sends the last event's command again (which would, for
 * example, apply a nudge twice). An event fired while the timeline isn't in the store yet waits
 * and is sent once the timeline arrives, so the edit isn't lost.
 */
export function createTimelineEventEffect<TEvent>(
  event: Accessor<TEvent | undefined>,
  timeline: () => types.Timeline | undefined,
  send: (event: TEvent, timeline: types.Timeline) => void,
): void {
  let pending: TEvent | undefined;

  /** Sends the pending event if the timeline is available, then forgets it. */
  const flush = () => {
    const target = untrack(timeline);
    if (pending === undefined || !target) return;
    const current = pending;
    pending = undefined;
    send(current, target);
  };

  /** Queues each new event and sends it right away when the timeline is loaded. */
  createEffect(
    on(event, (current) => {
      if (current === undefined) return;
      pending = current;
      flush();
    }),
  );

  /** Sends an event that fired before the timeline reached the store, once it arrives. */
  createEffect(() => {
    if (timeline()) untrack(flush);
  });
}
