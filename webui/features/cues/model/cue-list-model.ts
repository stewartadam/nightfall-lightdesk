// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Cue, Sequence } from "../../../types";

export interface SequenceWithCues {
  sequence: Sequence;
  cues: Cue[];
}

export interface CueGroup {
  key: string;
  title: string;
  sequenceId: number | null;
  cues: Cue[];
}

export interface CueListGroupRow {
  rowKind: "group";
  groupKey: string;
  title: string;
  sequenceId: number | null;
  cueCount: number;
  isCollapsed: boolean;
}

export interface CueListCueRow {
  rowKind: "cue";
  groupKey: string;
  sequenceId: number | null;
  cueUid: string;
  cue: Cue;
}

export type CueListDisplayRow = CueListGroupRow | CueListCueRow;

export interface GroupedCueData {
  sequencesWithCues: SequenceWithCues[];
  ungroupedCues: Cue[];
}

/** Groups matching cues by sequence while preserving sequence step order. */
export function groupCueData(
  cueMap: Record<string, Cue>,
  sequenceMap: Record<string, Sequence>,
  matches: (cue: Cue, sequence?: Sequence) => boolean,
): GroupedCueData {
  const allCues = Object.values(cueMap);
  if (allCues.length === 0) return { sequencesWithCues: [], ungroupedCues: [] };
  const sequencesWithCues: SequenceWithCues[] = [];
  const usedCueUids = new Set<string>();
  for (const sequence of Object.values(sequenceMap)) {
    const sequenceCues: Cue[] = [];
    for (const cueUid of sequence.steps) {
      const cue = cueMap[cueUid];
      if (!cue) continue;
      usedCueUids.add(cueUid);
      if (matches(cue, sequence)) sequenceCues.push(cue);
    }
    if (sequenceCues.length > 0)
      sequencesWithCues.push({ sequence, cues: sequenceCues });
  }
  const ungroupedCues = allCues.filter(
    (cue) => !usedCueUids.has(cue.identifiers.uid) && matches(cue),
  );
  sequencesWithCues.sort(
    (a, b) => a.sequence.identifiers.id - b.sequence.identifiers.id,
  );
  ungroupedCues.sort((a, b) => a.identifiers.id - b.identifiers.id);
  return { sequencesWithCues, ungroupedCues };
}

/** Projects grouped cue data into operator-facing display groups. */
export function buildCueGroups(grouped: GroupedCueData): CueGroup[] {
  const groups: CueGroup[] = grouped.sequencesWithCues.map((entry) => ({
    key: `sequence-${entry.sequence.identifiers.uid}`,
    title: `Sequence ${entry.sequence.identifiers.id}: ${entry.sequence.identifiers.label}`,
    sequenceId: entry.sequence.identifiers.id,
    cues: entry.cues,
  }));
  if (grouped.ungroupedCues.length > 0) {
    groups.push({
      key: "ungrouped",
      title: "Ungrouped Cues",
      sequenceId: null,
      cues: grouped.ungroupedCues,
    });
  }
  return groups;
}

/** Flattens cue groups into collapsible list rows. */
export function buildCueListRows(
  groups: CueGroup[],
  collapsedGroupKeys: ReadonlySet<string>,
): CueListDisplayRow[] {
  const rows: CueListDisplayRow[] = [];
  for (const group of groups) {
    const isCollapsed = collapsedGroupKeys.has(group.key);
    rows.push({
      rowKind: "group",
      groupKey: group.key,
      title: group.title,
      sequenceId: group.sequenceId,
      cueCount: group.cues.length,
      isCollapsed,
    });
    if (isCollapsed) continue;
    for (const cue of group.cues) {
      rows.push({
        rowKind: "cue",
        groupKey: group.key,
        sequenceId: group.sequenceId,
        cueUid: cue.identifiers.uid.toString(),
        cue,
      });
    }
  }
  return rows;
}

/** Returns cue UIDs in the same sequence-first order as the grid view. */
export function buildCueGridOrder(grouped: GroupedCueData): string[] {
  return [
    ...grouped.sequencesWithCues.flatMap((entry) =>
      entry.cues.map((cue) => cue.identifiers.uid.toString()),
    ),
    ...grouped.ungroupedCues.map((cue) => cue.identifiers.uid.toString()),
  ];
}

/** Resolves the unfiltered display group containing one cue UID. */
export function cueGroupKeyForUid(
  cueUid: string,
  cueMap: Record<string, Cue>,
  sequenceMap: Record<string, Sequence>,
): string | null {
  for (const sequence of Object.values(sequenceMap)) {
    if (sequence.steps.some((stepUid) => stepUid.toString() === cueUid))
      return `sequence-${sequence.identifiers.uid}`;
  }
  return cueMap[cueUid] ? "ungrouped" : null;
}
