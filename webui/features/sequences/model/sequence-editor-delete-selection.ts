// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  CompactSelection,
  type GridSelection,
} from "../../../lib/data-grid-types";
import { getEditTargetRowIndices } from "../../../lib/datagrid";
import type * as types from "../../../types";

export interface SequenceEditorDeleteRow {
  rowKind: "cue" | "part" | "summary";
  cueUid: string;
  cue?: types.Cue;
  partId?: number;
  sequenceIndex: number;
  isMissing: boolean;
  isSetupCue?: boolean;
  isReleaseCue?: boolean;
}

export interface SequenceEditorPartDeleteTarget {
  cue: types.Cue;
  partIds: Set<number>;
}

export interface SequenceEditorDeleteTargets {
  cueSequenceIndices: number[];
  partTargetsByCueUid: Map<string, SequenceEditorPartDeleteTarget>;
  blockedBasePartSequenceIndices: Set<number>;
  targetCount: number;
}

/** Returns the row-marker indexes selected in the data grid. */
export function selectedSequenceEditorDeleteRowIndices(
  selection: GridSelection | undefined,
): number[] {
  if (!selection) return [];

  const indices: number[] = [];
  for (const index of selection.rows) {
    indices.push(index);
  }
  return indices;
}

/** Returns selected row indexes used by structural delete actions. */
export function selectedSequenceEditorStructuralDeleteRowIndices(
  selection: GridSelection | undefined,
  maxRows: number,
): number[] {
  const selectedRows = selectedSequenceEditorDeleteRowIndices(selection);
  if (selectedRows.length > 0 || !selection?.current) return selectedRows;

  return getEditTargetRowIndices(selection, maxRows);
}

/** Returns a valid grid selection to publish after structural row deletion changes row indexes. */
export function sequenceEditorSelectionAfterStructuralDelete(
  selection: GridSelection | undefined,
  deletedRowIndices: readonly number[],
  rowCount: number,
): GridSelection {
  const emptySelection = {
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  };
  if (rowCount <= 0) return emptySelection;

  const deletedRows = [...new Set(deletedRowIndices)]
    .filter((rowIndex) => rowIndex >= 0)
    .sort((a, b) => a - b);
  const sourceCell = selection?.current?.cell;
  const sourceCol = sourceCell?.[0] ?? 0;
  const sourceCellRow = sourceCell?.[1];
  const sourceRow =
    sourceCellRow !== undefined &&
    (deletedRows.length === 0 || deletedRows.includes(sourceCellRow))
      ? sourceCellRow
      : (deletedRows[0] ?? sourceCellRow ?? 0);
  const deletedBeforeSourceRow = deletedRows.filter(
    (rowIndex) => rowIndex < sourceRow,
  ).length;
  const targetRow = Math.min(
    Math.max(sourceRow - deletedBeforeSourceRow, 0),
    rowCount - 1,
  );

  return {
    ...emptySelection,
    current: {
      cell: [sourceCol, targetRow],
      range: { x: sourceCol, y: targetRow, width: 1, height: 1 },
      rangeStack: [],
    },
  };
}

/** Converts selected sequence editor rows into structural cue and part delete targets. */
export function collectSequenceEditorDeleteTargets(
  rows: readonly SequenceEditorDeleteRow[],
  rowIndices: readonly number[],
): SequenceEditorDeleteTargets {
  const cueSequenceIndices = new Set<number>();
  const uniqueRowIndices = [...new Set(rowIndices)].sort((a, b) => a - b);

  for (const rowIndex of uniqueRowIndices) {
    const row = rows[rowIndex];
    if (!row?.cue || row.isMissing || row.rowKind !== "cue") continue;
    if (row.isSetupCue || row.isReleaseCue) continue;

    cueSequenceIndices.add(row.sequenceIndex);
  }

  const partTargetsByCueUid = new Map<string, SequenceEditorPartDeleteTarget>();
  const blockedBasePartSequenceIndices = new Set<number>();
  for (const rowIndex of uniqueRowIndices) {
    const row = rows[rowIndex];
    if (!row?.cue || row.isMissing || row.rowKind !== "part") continue;
    if (row.isSetupCue || row.isReleaseCue) continue;
    if (cueSequenceIndices.has(row.sequenceIndex)) continue;
    if (row.partId === undefined) continue;
    if (row.partId === 0) {
      blockedBasePartSequenceIndices.add(row.sequenceIndex);
      continue;
    }

    const target = partTargetsByCueUid.get(row.cueUid) ?? {
      cue: row.cue,
      partIds: new Set<number>(),
    };
    target.partIds.add(row.partId);
    partTargetsByCueUid.set(row.cueUid, target);
  }

  let partTargetCount = 0;
  for (const target of partTargetsByCueUid.values()) {
    partTargetCount += target.partIds.size;
  }

  return {
    cueSequenceIndices: [...cueSequenceIndices].sort((a, b) => a - b),
    partTargetsByCueUid,
    blockedBasePartSequenceIndices,
    targetCount: cueSequenceIndices.size + partTargetCount,
  };
}

/** Returns whether collected structural delete targets can be applied. */
export function canApplySequenceEditorDeleteTargets(
  targets: SequenceEditorDeleteTargets,
): boolean {
  return (
    targets.targetCount > 0 && targets.blockedBasePartSequenceIndices.size === 0
  );
}
