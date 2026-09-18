// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Cue,
  FadeCurve,
  type Sequence,
  TrackingFlags,
  type TrackingMode,
  type Transition,
  type TransitionMode,
} from "../types";

/** Creates the compact persisted UID form used by UI-created show objects. */
export function createShowObjectUid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Returns the lowest positive integer not used by the provided objects. */
export function nextAvailableIdentifierId(
  objects: Iterable<{ identifiers: { id: number } }>,
): number {
  const existingIds = new Set<number>();
  for (const object of objects) {
    existingIds.add(object.identifiers.id);
  }

  let id = 1;
  while (existingIds.has(id)) {
    id += 1;
  }
  return id;
}

/** Creates a zero fixed transition mode for new sequence defaults. */
export function createFixedZeroMode(): TransitionMode {
  return {
    type: "Fixed",
    data: { secs: 0, nanos: 0 },
  };
}

/** Creates the default concrete tracking flags for setup and sequence defaults. */
export function createDefaultTrackingFlags(): TrackingFlags {
  return { __Composed__: 7 } as unknown as TrackingFlags;
}

/** Creates the default concrete tracking mode for new sequences. */
export function createDefaultTrackingMode(): TrackingMode {
  return {
    type: "Flags",
    data: createDefaultTrackingFlags(),
  };
}

/** Creates the inherited tracking mode for sequence-owned cues. */
export function createInheritedTrackingMode(): TrackingMode {
  return { type: "Inherit" };
}

/** Creates the default transition used by newly created sequences. */
export function createDefaultSequenceTiming(): Transition {
  return {
    delay_in: createFixedZeroMode(),
    fade_in: createFixedZeroMode(),
    curve_in: FadeCurve.Linear,
    delay_out: createFixedZeroMode(),
    fade_out: createFixedZeroMode(),
    curve_out: FadeCurve.Linear,
  };
}

/** Creates the built-in setup cue for a new sequence. */
export function createDefaultSetupCue(): Cue {
  return {
    identifiers: {
      id: 0,
      uid: createShowObjectUid(),
      label: "Setup",
    },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    tracking_flags: createDefaultTrackingFlags(),
    tracking_mode: createDefaultTrackingMode(),
  };
}

/** Creates the built-in release cue for a new sequence. */
export function createDefaultReleaseCue(): Cue {
  return {
    identifiers: {
      id: 0,
      uid: createShowObjectUid(),
      label: "Release",
    },
    trigger: { type: "FollowPrevious" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    tracking_flags: TrackingFlags.HTP,
    tracking_mode: createInheritedTrackingMode(),
  };
}

/** Creates a new empty sequence using the standard UI defaults. */
export function createDefaultSequence(options: {
  id: number;
  label?: string;
  uid?: string;
}): Sequence {
  return {
    identifiers: {
      id: options.id,
      uid: options.uid ?? createShowObjectUid(),
      label: options.label ?? `sequence ${options.id}`,
    },
    steps: [],
    wrap: false,
    release_on_start: false,
    setup_cue: createDefaultSetupCue(),
    release_cue: createDefaultReleaseCue(),
    default_timing: createDefaultSequenceTiming(),
    tracking_mode: createDefaultTrackingMode(),
  };
}

/** Creates an empty cue suitable for insertion into a sequence. */
export function createDefaultSequenceStepCue(options: {
  id: number;
  label?: string;
  uid?: string;
  trigger?: Cue["trigger"];
}): Cue {
  return {
    identifiers: {
      id: options.id,
      uid: options.uid ?? createShowObjectUid(),
      label: options.label ?? `Cue ${options.id}`,
    },
    trigger: options.trigger ?? { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    tracking_flags: TrackingFlags.HTP,
    tracking_mode: createInheritedTrackingMode(),
  };
}
