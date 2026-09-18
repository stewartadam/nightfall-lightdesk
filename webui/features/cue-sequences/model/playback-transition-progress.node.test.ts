// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types/index";
import {
  findTopmostCuePlayback,
  findTopmostSequencePlayback,
  playbackSequenceCueTransitionClocks,
  playbackSequenceNextCueUid,
  playbackTransitionClock,
} from "./playback-transition-progress";

/** Builds an object reference for one source object UID. */
function objectRef(objectType: types.ObjectType, uid: string): types.ObjectRef {
  return {
    type: "ByUid",
    data: {
      object_type: objectType,
      uid,
    },
  };
}

/** Builds a instance runtime status with optional sequence position data. */
function status(options: {
  activationMs: number;
  transitionElapsedMs?: number;
  sequenceUid?: string;
  currentCueUid?: string;
  nextCueUid?: string;
  retainedCues?: types.InstanceSequenceCueStatus[];
}): types.InstanceStatus {
  return {
    position: options.sequenceUid
      ? {
          type: "Sequence",
          data: {
            sequence_uid: options.sequenceUid,
            current_position: 1,
            cue_count: 1,
            current_cue_uid: options.currentCueUid,
            current_part_count: 1,
            next_cue_uid: options.nextCueUid,
            retained_cues: options.retainedCues ?? [],
          },
        }
      : { type: "None" },
    source_activation_epoch_ms: options.activationMs,
    transition_elapsed:
      options.transitionElapsedMs === undefined
        ? undefined
        : {
            secs: Math.trunc(options.transitionElapsedMs / 1000),
            nanos: Math.trunc((options.transitionElapsedMs % 1000) * 1_000_000),
          },
  };
}

/** Builds a playback info record with one source object identity. */
function playback(options: {
  id: string;
  objectType: types.ObjectType;
  objectUid: string;
  activationMs: number;
  releaseMs?: number;
  isReleasing?: boolean;
  isPaused?: boolean;
  transitionElapsedMs?: number;
  sequenceUid?: string;
  currentCueUid?: string;
  nextCueUid?: string;
  retainedCues?: types.InstanceSequenceCueStatus[];
}): types.InstanceInfo {
  return {
    instance_id: options.id,
    kind:
      options.objectType === types.ObjectType.Sequence
        ? types.InstanceKind.Sequence
        : types.InstanceKind.Cue,
    display_kind:
      options.objectType === types.ObjectType.Sequence
        ? types.InstanceDisplayKind.Sequence
        : types.InstanceDisplayKind.Cue,
    tags: [],
    object_ref: objectRef(options.objectType, options.objectUid),
    is_preview: false,
    is_releasing: options.isReleasing ?? false,
    is_paused: options.isPaused ?? false,
    release_epoch_ms: options.releaseMs,
    activation_epoch_ms: options.activationMs,
    transition_elapsed:
      options.transitionElapsedMs === undefined
        ? undefined
        : {
            secs: Math.trunc(options.transitionElapsedMs / 1000),
            nanos: Math.trunc((options.transitionElapsedMs % 1000) * 1_000_000),
          },
    owner_uids: [],
    intensity_scale: 1,
    rate: 1,
    rate_master_scale: 1,
    effective_rate: 1,
    status: status({
      activationMs: options.activationMs,
      transitionElapsedMs: options.transitionElapsedMs,
      sequenceUid: options.sequenceUid,
      currentCueUid: options.currentCueUid,
      nextCueUid: options.nextCueUid,
      retainedCues: options.retainedCues,
    }),
  };
}

/** Builds a layer stack entry with the requested source object identity. */
function layer(
  objectType: types.ObjectType,
  objectUid: string,
): types.OutboundLayerState {
  return {
    creator: `${objectType}:${objectUid}`,
    object_ref: objectRef(objectType, objectUid),
    priority: 1,
    is_releasing: false,
    asserted_absolute_values: [],
    asserted_relative_values: [],
    lookahead_asserted_values: [],
    computed_values: [],
    computed_transitioning: [],
  };
}

test("findTopmostCuePlayback follows the topmost matching layer source", () => {
  const cueUid = "69e0f75b-d2a9-4b07-b07d-7c83a96345ee";
  const sequenceUid = "01234567-89ab-4def-8123-456789abcdef";
  const instances = {
    cue: playback({
      id: "cue",
      objectType: types.ObjectType.Cue,
      objectUid: cueUid,
      activationMs: 1000,
    }),
    sequence: playback({
      id: "sequence",
      objectType: types.ObjectType.Sequence,
      objectUid: sequenceUid,
      activationMs: 2000,
      sequenceUid,
      currentCueUid: cueUid,
    }),
  };
  const layers = [
    layer(types.ObjectType.Cue, cueUid),
    layer(types.ObjectType.Sequence, sequenceUid),
  ];

  assert.equal(
    findTopmostCuePlayback(instances, layers, cueUid)?.instance_id,
    "sequence",
  );
});

test("findTopmostSequencePlayback uses newest playback for duplicate sequence sources", () => {
  const sequenceUid = "01234567-89ab-4def-8123-456789abcdef";
  const instances = {
    older: playback({
      id: "older",
      objectType: types.ObjectType.Sequence,
      objectUid: sequenceUid,
      activationMs: 1000,
      sequenceUid,
    }),
    newer: playback({
      id: "newer",
      objectType: types.ObjectType.Sequence,
      objectUid: sequenceUid,
      activationMs: 2000,
      sequenceUid,
    }),
  };

  assert.equal(
    findTopmostSequencePlayback(
      instances,
      [layer(types.ObjectType.Sequence, sequenceUid)],
      sequenceUid,
    )?.instance_id,
    "newer",
  );
});

test("playbackTransitionClock calculates in-progress elapsed from activation timestamp", () => {
  const active = playback({
    id: "cue",
    objectType: types.ObjectType.Cue,
    objectUid: "69e0f75b-d2a9-4b07-b07d-7c83a96345ee",
    activationMs: 1_000,
  });

  assert.deepEqual(playbackTransitionClock(active, 2_500), {
    phase: "in",
    elapsedSeconds: 1.5,
  });
});

test("playbackSequenceNextCueUid reads the pending sequence cue", () => {
  const sequenceUid = "01234567-89ab-4def-8123-456789abcdef";
  const nextCueUid = "53ba7998-9933-4e63-aa73-b1810084a7c8";
  const active = playback({
    id: "sequence",
    objectType: types.ObjectType.Sequence,
    objectUid: sequenceUid,
    activationMs: 1_000,
    sequenceUid,
    currentCueUid: "69e0f75b-d2a9-4b07-b07d-7c83a96345ee",
    nextCueUid,
  });

  assert.equal(
    playbackSequenceNextCueUid(active),
    nextCueUid.replaceAll("-", ""),
  );
});

test("playbackTransitionClock calculates out-progress elapsed from release timestamp", () => {
  const releasing = playback({
    id: "cue",
    objectType: types.ObjectType.Cue,
    objectUid: "69e0f75b-d2a9-4b07-b07d-7c83a96345ee",
    activationMs: 1_000,
    releaseMs: 30_000,
    isReleasing: true,
  });

  assert.deepEqual(playbackTransitionClock(releasing, 30_500), {
    phase: "out",
    elapsedSeconds: 0.5,
  });
});

test("playbackTransitionClock prefers source-local release elapsed", () => {
  const releasing = playback({
    id: "cue",
    objectType: types.ObjectType.Cue,
    objectUid: "69e0f75b-d2a9-4b07-b07d-7c83a96345ee",
    activationMs: 1_000,
    releaseMs: 30_000,
    isReleasing: true,
    transitionElapsedMs: 750,
  });

  assert.deepEqual(playbackTransitionClock(releasing, 100_000), {
    phase: "out",
    elapsedSeconds: 0.75,
  });
});

test("playbackTransitionClock prefers source-local transition elapsed", () => {
  const pausedSeek = playback({
    id: "cue",
    objectType: types.ObjectType.Cue,
    objectUid: "69e0f75b-d2a9-4b07-b07d-7c83a96345ee",
    activationMs: 1_000,
    isPaused: true,
    transitionElapsedMs: 250,
  });

  assert.deepEqual(playbackTransitionClock(pausedSeek, 100_000), {
    phase: "in",
    elapsedSeconds: 0.25,
  });
});

test("playbackTransitionClock uses source-local transition elapsed for running sequences", () => {
  const runningSequence = playback({
    id: "sequence",
    objectType: types.ObjectType.Sequence,
    objectUid: "01234567-89ab-4def-8123-456789abcdef",
    activationMs: 1_000,
    transitionElapsedMs: 250,
    sequenceUid: "01234567-89ab-4def-8123-456789abcdef",
    currentCueUid: "69e0f75b-d2a9-4b07-b07d-7c83a96345ee",
  });

  assert.deepEqual(playbackTransitionClock(runningSequence, 100_000), {
    phase: "in",
    elapsedSeconds: 0.25,
  });
});

test("playbackSequenceCueTransitionClocks returns retained cue elapsed clocks", () => {
  const retainedCueUid = "69e0f75b-d2a9-4b07-b07d-7c83a96345ee";
  const runningSequence = playback({
    id: "sequence",
    objectType: types.ObjectType.Sequence,
    objectUid: "01234567-89ab-4def-8123-456789abcdef",
    activationMs: 1_000,
    sequenceUid: "01234567-89ab-4def-8123-456789abcdef",
    currentCueUid: retainedCueUid,
    retainedCues: [
      {
        position: 1,
        cue_uid: retainedCueUid,
        transition_elapsed: { secs: 0, nanos: 724_000_000 },
      },
    ],
  });

  assert.deepEqual(playbackSequenceCueTransitionClocks(runningSequence), {
    [retainedCueUid.replaceAll("-", "")]: {
      phase: "in",
      elapsedSeconds: 0.724,
    },
  });
});

test("playbackSequenceCueTransitionClocks ignores releasing sequence status", () => {
  const runningSequence = playback({
    id: "sequence",
    objectType: types.ObjectType.Sequence,
    objectUid: "01234567-89ab-4def-8123-456789abcdef",
    activationMs: 1_000,
    releaseMs: 2_000,
    isReleasing: true,
    sequenceUid: "01234567-89ab-4def-8123-456789abcdef",
    currentCueUid: "69e0f75b-d2a9-4b07-b07d-7c83a96345ee",
    retainedCues: [
      {
        position: 1,
        cue_uid: "69e0f75b-d2a9-4b07-b07d-7c83a96345ee",
        transition_elapsed: { secs: 0, nanos: 724_000_000 },
      },
    ],
  });

  assert.deepEqual(playbackSequenceCueTransitionClocks(runningSequence), {});
});

test("playbackTransitionClock keeps wall-clock animation for running instance", () => {
  const running = playback({
    id: "cue",
    objectType: types.ObjectType.Cue,
    objectUid: "69e0f75b-d2a9-4b07-b07d-7c83a96345ee",
    activationMs: 1_000,
    transitionElapsedMs: 250,
  });

  assert.deepEqual(playbackTransitionClock(running, 2_500), {
    phase: "in",
    elapsedSeconds: 1.5,
  });
});

/** Verifies running previews use sought backend time rather than their original activation time. */
test("playbackTransitionClock follows preview time after seeking", () => {
  const preview = playback({
    id: "cue",
    objectType: types.ObjectType.Cue,
    objectUid: "69e0f75b-d2a9-4b07-b07d-7c83a96345ee",
    activationMs: 1_000,
    transitionElapsedMs: 250,
  });
  preview.is_preview = true;
  assert.deepEqual(playbackTransitionClock(preview, 2_500), {
    phase: "in",
    elapsedSeconds: 0.25,
  });
});
