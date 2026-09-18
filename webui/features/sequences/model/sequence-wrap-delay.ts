// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { durationToSeconds, msToDuration } from "../../../lib/duration";
import type * as types from "../../../types";

export const WRAP_DELAY_TRIGGER_LABEL = "Wrap Delay";

/** Returns a trigger duration payload, defaulting non-duration triggers to zero. */
export function triggerDurationOrZero(
  trigger: types.CueTriggerType,
): types.Duration {
  return trigger.type === "AfterDelay" || trigger.type === "At"
    ? trigger.data
    : msToDuration(0);
}

/** Returns whether a duration value represents zero elapsed time. */
export function durationIsZero(duration: types.Duration): boolean {
  return durationToSeconds(duration) === 0;
}

/** Returns whether the trigger variant stores a duration payload. */
function isDurationTrigger(
  trigger: types.CueTriggerType,
): trigger is Extract<types.CueTriggerType, { type: "AfterDelay" | "At" }> {
  return trigger.type === "AfterDelay" || trigger.type === "At";
}

/** Builds the runtime trigger represented by the sequence wrap-delay cell. */
export function wrapDelayTrigger(
  duration: types.Duration,
): types.CueTriggerType {
  return {
    type: "AfterDelay",
    data: duration,
  };
}

/** Builds the trigger stored after editing a trigger duration cell. */
export function triggerDurationEdit(
  source: types.CueTriggerType,
  duration: types.Duration,
  isWrapDelay: boolean,
): types.CueTriggerType {
  if (isWrapDelay) {
    return wrapDelayTrigger(duration);
  }
  return {
    type: isDurationTrigger(source) ? source.type : "AfterDelay",
    data: duration,
  };
}

/** Returns the first persisted step cue in a sequence, if it is loaded. */
export function firstSequenceCue(
  sequence: types.Sequence | undefined,
  cueMap: Record<string, types.Cue | undefined>,
): types.Cue | undefined {
  const firstCueUid = sequence?.steps[0];
  return firstCueUid ? cueMap[firstCueUid] : undefined;
}

/** Normalizes cue 1 so it stores the sequence wrap delay contract. */
export function normalizeFirstCueWrapDelay(
  cue: types.Cue,
  wrap: boolean,
): types.Cue | undefined {
  const nextDuration = wrap
    ? triggerDurationOrZero(cue.trigger)
    : msToDuration(0);
  const alreadyNormalized =
    cue.trigger.type === "AfterDelay" &&
    (wrap || durationIsZero(cue.trigger.data));

  if (alreadyNormalized) {
    return undefined;
  }

  return {
    ...cue,
    trigger: {
      type: "AfterDelay",
      data: nextDuration,
    },
  };
}
