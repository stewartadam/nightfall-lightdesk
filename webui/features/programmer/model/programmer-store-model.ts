// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";
import {
  type CueTargetOption,
  clampIdInput,
  type GroupTargetOption,
} from "./programmer-grid-model";

export interface CueDialogDefaults {
  sequenceId: number;
  cueId: number;
  label: string;
}

/** Projects sorted sequence cue targets for the store-cue selector. */
export function buildCueTargetOptions(
  cueMap: Record<string, types.Cue>,
  sequenceMap: Record<string, types.Sequence>,
): CueTargetOption[] {
  const seen = new Set<string>();
  const options: CueTargetOption[] = [];
  const sortedSequences = Object.values(sequenceMap).sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  );

  for (const sequence of sortedSequences) {
    const sequenceLabel =
      sequence.identifiers.label.trim() ||
      `Sequence ${sequence.identifiers.id}`;
    for (const cueUid of sequence.steps) {
      const cue = cueMap[cueUid];
      if (!cue) continue;

      const key = `${sequence.identifiers.id}.${cue.identifiers.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        key,
        sequenceId: sequence.identifiers.id,
        cueId: cue.identifiers.id,
        cueLabel: cue.identifiers.label.trim() || `Cue ${cue.identifiers.id}`,
        sequenceLabel,
      });
    }
  }
  return options;
}

/** Projects sorted group targets for the store-group selector. */
export function buildGroupTargetOptions(
  groupMap: Record<string, types.Group>,
): GroupTargetOption[] {
  return Object.values(groupMap)
    .sort((left, right) => left.identifiers.id - right.identifiers.id)
    .map((group) => ({
      key: `${group.identifiers.id}`,
      groupId: group.identifiers.id,
      label: group.identifiers.label.trim() || `Group ${group.identifiers.id}`,
    }));
}

/** Returns the first unused group ID after the sorted target list. */
export function nextAvailableGroupId(options: GroupTargetOption[]): number {
  return options.length === 0 ? 1 : options[options.length - 1]!.groupId + 1;
}

/** Chooses the initial sequence and next cue ID for the store-cue dialog. */
export function cueDialogDefaults(
  sequenceMap: Record<string, types.Sequence>,
  cueTargets: CueTargetOption[],
): CueDialogDefaults {
  const sequenceIds = Object.values(sequenceMap)
    .map((sequence) => sequence.identifiers.id)
    .sort((left, right) => left - right);
  const sequenceId = sequenceIds[0] ?? 1;
  const cueIds = cueTargets
    .filter((target) => target.sequenceId === sequenceId)
    .map((target) => target.cueId)
    .sort((left, right) => left - right);
  const cueId = cueIds.length === 0 ? 1 : cueIds[cueIds.length - 1]! + 1;
  return { sequenceId, cueId, label: `Cue ${cueId}` };
}

/** Builds the programmer command that stores the current state as a cue. */
export function buildStoreCueCommand(
  sequenceId: number,
  cueId: number,
  label: string,
): types.ProgrammerCommand {
  const normalizedCueId = clampIdInput(cueId);
  return {
    type: "StoreCue",
    data: {
      sequence_id: clampIdInput(sequenceId),
      cue_id: { type: "Exact", data: normalizedCueId },
      part_id: { type: "Exact", data: 0 },
      mode: "replace" as types.StoreMode,
      label: label.trim() || `Cue ${normalizedCueId}`,
    },
  };
}

/** Builds the programmer command that stores the selection as a group. */
export function buildStoreGroupCommand(
  groupId: number,
  label: string,
): types.ProgrammerCommand {
  const trimmedLabel = label.trim();
  return {
    type: "StoreGroup",
    data: {
      group_id: clampIdInput(groupId),
      label: trimmedLabel.length > 0 ? trimmedLabel : undefined,
    },
  };
}

/** Builds the command that releases all current programmer state. */
export function buildClearProgrammerCommand(): types.ProgrammerCommand {
  return { type: "ClearProgrammer" };
}
