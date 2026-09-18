// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { normalizeFixtureUid } from "../../../lib/binding-utils";
import { durationToSeconds } from "../../../lib/duration";
import * as types from "../../../types";

export type PlaybackTransitionPhase = "in" | "out";

export type PlaybackTransitionClock = {
  phase: PlaybackTransitionPhase;
  elapsedSeconds: number;
};

/** Normalizes object UID values from websocket payloads and local stores. */
export function normalizePlaybackUid(uid: unknown): string {
  return normalizeFixtureUid(uid).toLowerCase();
}

/** Returns the UID for an object ref when it points at the requested object type. */
function objectRefUid(
  objectRef: types.ObjectRef | undefined,
  objectType: types.ObjectType,
): string | undefined {
  if (
    objectRef?.type !== "ByUid" ||
    objectRef.data.object_type !== objectType
  ) {
    return undefined;
  }
  return normalizePlaybackUid(objectRef.data.uid);
}

/** Returns the sequence source UID carried by a sequence-position instance status. */
function sequenceStatusUid(playback: types.InstanceInfo): string | undefined {
  const position = playback.status.position;
  if (position.type !== "Sequence") return undefined;
  return normalizePlaybackUid(position.data.sequence_uid);
}

/** Returns the current cue UID carried by a sequence-position instance status. */
export function playbackSequenceCurrentCueUid(
  playback: types.InstanceInfo | undefined,
): string | undefined {
  if (!playback) return undefined;
  const position = playback.status.position;
  if (position.type !== "Sequence") return undefined;
  const cueUid = position.data.current_cue_uid;
  return cueUid ? normalizePlaybackUid(cueUid) : undefined;
}

/** Returns the next cue UID carried by a sequence-position instance status. */
export function playbackSequenceNextCueUid(
  playback: types.InstanceInfo | undefined,
): string | undefined {
  if (!playback) return undefined;
  const position = playback.status.position;
  if (position.type !== "Sequence") return undefined;
  const cueUid = position.data.next_cue_uid;
  return cueUid ? normalizePlaybackUid(cueUid) : undefined;
}

/** Returns whether a playback directly renders the requested cue. */
function playbackDirectlyMatchesCue(
  playback: types.InstanceInfo,
  cueUid: string,
): boolean {
  return (
    objectRefUid(playback.object_ref, types.ObjectType.Cue) ===
    normalizePlaybackUid(cueUid)
  );
}

/** Returns whether a playback currently renders the requested cue through a sequence. */
function playbackSequenceMatchesCue(
  playback: types.InstanceInfo,
  cueUid: string,
): boolean {
  return (
    playbackSequenceCurrentCueUid(playback) === normalizePlaybackUid(cueUid)
  );
}

/** Returns the newest matching playback by source activation timestamp. */
function newestPlayback(
  instances: Iterable<types.InstanceInfo>,
): types.InstanceInfo | undefined {
  let newest: types.InstanceInfo | undefined;
  for (const playback of instances) {
    if (
      newest === undefined ||
      (playback.status.source_activation_epoch_ms ?? 0) >=
        (newest.status.source_activation_epoch_ms ?? 0)
    ) {
      newest = playback;
    }
  }
  return newest;
}

/** Returns the topmost layer matching the supplied predicate. */
function topmostLayer(
  layers: readonly types.OutboundLayerState[],
  matches: (layer: types.OutboundLayerState) => boolean,
): types.OutboundLayerState | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (matches(layer)) return layer;
  }
  return undefined;
}

/** Returns the active instance whose layer is visibly rendering the requested cue. */
export function findTopmostCuePlayback(
  instances: Record<string, types.InstanceInfo>,
  layers: readonly types.OutboundLayerState[],
  cueUid: string,
): types.InstanceInfo | undefined {
  const normalizedCueUid = normalizePlaybackUid(cueUid);
  const playbackList = Object.values(instances);
  const sequenceUidsWithCue = new Set(
    playbackList
      .filter((playback) =>
        playbackSequenceMatchesCue(playback, normalizedCueUid),
      )
      .map((playback) => sequenceStatusUid(playback))
      .filter((uid): uid is string => uid !== undefined),
  );

  const layer = topmostLayer(layers, (layer) => {
    const directCueUid = objectRefUid(layer.object_ref, types.ObjectType.Cue);
    if (directCueUid === normalizedCueUid) return true;
    const sequenceUid = objectRefUid(
      layer.object_ref,
      types.ObjectType.Sequence,
    );
    return sequenceUid !== undefined && sequenceUidsWithCue.has(sequenceUid);
  });

  if (!layer) return undefined;

  const directCueUid = objectRefUid(layer.object_ref, types.ObjectType.Cue);
  if (directCueUid === normalizedCueUid) {
    return newestPlayback(
      playbackList.filter((playback) =>
        playbackDirectlyMatchesCue(playback, normalizedCueUid),
      ),
    );
  }

  const sequenceUid = objectRefUid(layer.object_ref, types.ObjectType.Sequence);
  if (!sequenceUid) return undefined;
  return newestPlayback(
    playbackList.filter(
      (playback) =>
        sequenceStatusUid(playback) === sequenceUid &&
        playbackSequenceMatchesCue(playback, normalizedCueUid),
    ),
  );
}

/** Returns the active instance whose layer is visibly rendering the requested sequence. */
export function findTopmostSequencePlayback(
  instances: Record<string, types.InstanceInfo>,
  layers: readonly types.OutboundLayerState[],
  sequenceUid: string,
): types.InstanceInfo | undefined {
  const normalizedSequenceUid = normalizePlaybackUid(sequenceUid);
  const layer = topmostLayer(
    layers,
    (layer) =>
      objectRefUid(layer.object_ref, types.ObjectType.Sequence) ===
      normalizedSequenceUid,
  );
  if (!layer) return undefined;
  return newestPlayback(
    Object.values(instances).filter(
      (playback) =>
        objectRefUid(playback.object_ref, types.ObjectType.Sequence) ===
          normalizedSequenceUid ||
        sequenceStatusUid(playback) === normalizedSequenceUid,
    ),
  );
}

/** Returns the active transition phase and elapsed seconds for one instance. */
export function playbackTransitionClock(
  playback: types.InstanceInfo | undefined,
  nowEpochMs: number,
): PlaybackTransitionClock | undefined {
  if (!playback) return undefined;
  const phase: PlaybackTransitionPhase = playback.is_releasing ? "out" : "in";
  if (
    (playback.is_paused || playback.is_releasing) &&
    playback.transition_elapsed
  ) {
    return {
      phase,
      elapsedSeconds: durationToSeconds(playback.transition_elapsed),
    };
  }
  if (
    !playback.is_releasing &&
    (playback.is_preview || playback.status.position.type === "Sequence") &&
    playback.status.transition_elapsed
  ) {
    return {
      phase,
      elapsedSeconds: durationToSeconds(playback.status.transition_elapsed),
    };
  }
  const startedAt = playback.is_releasing
    ? playback.release_epoch_ms
    : playback.status.source_activation_epoch_ms;
  if (startedAt === undefined) return undefined;
  return {
    phase,
    elapsedSeconds: Math.max(0, (nowEpochMs - startedAt) / 1000),
  };
}

/** Returns in-phase transition clocks for sequence cues retained by an active playback. */
export function playbackSequenceCueTransitionClocks(
  playback: types.InstanceInfo | undefined,
): Record<string, PlaybackTransitionClock> {
  if (!playback || playback.is_releasing) return {};
  const position = playback.status.position;
  if (position.type !== "Sequence") return {};

  const clocks: Record<string, PlaybackTransitionClock> = {};
  for (const cue of position.data.retained_cues ?? []) {
    if (!cue.transition_elapsed) continue;
    clocks[normalizePlaybackUid(cue.cue_uid)] = {
      phase: "in",
      elapsedSeconds: durationToSeconds(cue.transition_elapsed),
    };
  }
  return clocks;
}
