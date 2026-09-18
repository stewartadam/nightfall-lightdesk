// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

type CreateUid = () => string;

interface DuplicateSequenceOptions {
  sourceSequence: types.Sequence;
  existingSequences: types.Sequence[];
  cuesByUid: Record<string, types.Cue>;
  createUid: CreateUid;
}

interface DuplicatedSequencePayload {
  sequence: types.Sequence;
  cues: types.Cue[];
}

/** Returns the lowest positive numeric sequence ID not already in use. */
function nextAvailableSequenceId(sequences: types.Sequence[]): number {
  const existingIds = new Set(
    sequences.map((sequence) => sequence.identifiers.id),
  );
  let candidate = 1;
  while (existingIds.has(candidate)) {
    candidate++;
  }
  return candidate;
}

/** Builds the display label used for a duplicated sequence. */
function duplicateSequenceLabel(
  sourceSequence: types.Sequence,
  newSequenceId: number,
): string {
  const sourceLabel = sourceSequence.identifiers.label.trim();
  if (!sourceLabel) {
    return `sequence ${newSequenceId}`;
  }
  return `${sourceLabel} Copy`;
}

/** Clones a cue part while assigning it a fresh UID. */
function cloneCuePartWithFreshUid(
  part: types.CuePart,
  createUid: CreateUid,
): types.CuePart {
  return {
    ...part,
    identifiers: {
      ...part.identifiers,
      uid: createUid(),
    },
  };
}

/** Clones a cue while assigning fresh UIDs to the cue and all nested parts. */
function cloneCueWithFreshUids(
  cue: types.Cue,
  createUid: CreateUid,
): types.Cue {
  const copiedCue: types.Cue = JSON.parse(JSON.stringify(cue));
  return {
    ...copiedCue,
    identifiers: {
      ...copiedCue.identifiers,
      uid: createUid(),
    },
    parts: copiedCue.parts?.map((part) =>
      cloneCuePartWithFreshUid(part, createUid),
    ),
  };
}

/**
 * Duplicates a sequence and the cue definitions referenced by its step list.
 *
 * Step cue copies preserve cue IDs and labels because cue IDs are scoped to the
 * containing sequence, while every persisted UID is regenerated so the copy can
 * be edited independently from the original sequence.
 */
export function duplicateSequencePayload({
  sourceSequence,
  existingSequences,
  cuesByUid,
  createUid,
}: DuplicateSequenceOptions): DuplicatedSequencePayload {
  const cueUidMap = new Map<string, string>();
  const copiedCues: types.Cue[] = [];

  for (const cueUid of sourceSequence.steps) {
    if (cueUidMap.has(cueUid)) {
      continue;
    }

    const cue = cuesByUid[cueUid];
    if (!cue) {
      continue;
    }

    const copiedCue = cloneCueWithFreshUids(cue, createUid);
    cueUidMap.set(cueUid, copiedCue.identifiers.uid);
    copiedCues.push(copiedCue);
  }

  const newSequenceId = nextAvailableSequenceId(existingSequences);
  const copiedSequence: types.Sequence = JSON.parse(
    JSON.stringify(sourceSequence),
  );
  copiedSequence.identifiers = {
    ...copiedSequence.identifiers,
    id: newSequenceId,
    uid: createUid(),
    label: duplicateSequenceLabel(sourceSequence, newSequenceId),
  };
  copiedSequence.steps = copiedSequence.steps.map(
    (cueUid) => cueUidMap.get(cueUid) ?? cueUid,
  );
  copiedSequence.setup_cue = cloneCueWithFreshUids(
    copiedSequence.setup_cue,
    createUid,
  );
  copiedSequence.release_cue = cloneCueWithFreshUids(
    copiedSequence.release_cue,
    createUid,
  );

  return {
    sequence: copiedSequence,
    cues: copiedCues,
  };
}
