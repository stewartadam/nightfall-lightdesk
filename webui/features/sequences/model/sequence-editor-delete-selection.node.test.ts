// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  CompactSelection,
  type GridSelection,
} from "../../../lib/data-grid-types";
import * as types from "../../../types";
import {
  canApplySequenceEditorDeleteTargets,
  collectSequenceEditorDeleteTargets,
  type SequenceEditorDeleteRow,
  selectedSequenceEditorDeleteRowIndices,
  selectedSequenceEditorStructuralDeleteRowIndices,
  sequenceEditorSelectionAfterStructuralDelete,
} from "./sequence-editor-delete-selection";

/** Creates the minimal cue shape needed by sequence editor delete-selection tests. */
function cue(
  uid: string,
  id: number,
  partIds: readonly number[] = [],
): types.Cue {
  return {
    identifiers: { id, uid, label: `Cue ${id}` },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: partIds.map((partId) => ({
      identifiers: { id: partId, uid: `${uid}-part-${partId}`, label: "" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      tracking_flags: types.TrackingFlags.HTP,
    })),
    tracking_flags: types.TrackingFlags.HTP,
  };
}

/** Builds the public grid selection used when row markers are checked. */
function rowSelection(rows: readonly number[]): GridSelection {
  return {
    columns: CompactSelection.empty(),
    rows: CompactSelection.fromArray([...rows]),
  };
}

/** Builds a sequence editor cue row for structural delete planning. */
function cueRow(
  cue: types.Cue,
  sequenceIndex: number,
): SequenceEditorDeleteRow {
  return {
    rowKind: "cue",
    cueUid: cue.identifiers.uid,
    cue,
    sequenceIndex,
    isMissing: false,
  };
}

/** Builds a sequence editor part row for structural delete planning. */
function partRow(
  cue: types.Cue,
  partId: number,
  sequenceIndex: number,
): SequenceEditorDeleteRow {
  return {
    rowKind: "part",
    cueUid: cue.identifiers.uid,
    cue,
    partId,
    sequenceIndex,
    isMissing: false,
  };
}

test("selectedSequenceEditorDeleteRowIndices expands selected row markers", () => {
  assert.deepEqual(
    selectedSequenceEditorDeleteRowIndices(rowSelection([4, 1, 3])),
    [1, 3, 4],
  );
});

test("selectedSequenceEditorStructuralDeleteRowIndices expands multi-row ranges", () => {
  assert.deepEqual(
    selectedSequenceEditorStructuralDeleteRowIndices(
      {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: [1, 4],
          range: { x: 1, y: 3, width: 2, height: 2 },
          rangeStack: [{ x: 0, y: 8, width: 1, height: 1 }],
        },
      },
      10,
    ),
    [3, 4, 8],
  );
});

test("selectedSequenceEditorStructuralDeleteRowIndices expands stacked single-cell rows", () => {
  assert.deepEqual(
    selectedSequenceEditorStructuralDeleteRowIndices(
      {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: [1, 5],
          range: { x: 1, y: 5, width: 1, height: 1 },
          rangeStack: [
            { x: 1, y: 2, width: 1, height: 1 },
            { x: 1, y: 3, width: 1, height: 1 },
          ],
        },
      },
      10,
    ),
    [2, 3, 5],
  );
});

test("sequenceEditorSelectionAfterStructuralDelete reselects the row replacing a deleted active row", () => {
  const selection = sequenceEditorSelectionAfterStructuralDelete(
    {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: [2, 3],
        range: { x: 2, y: 3, width: 1, height: 1 },
        rangeStack: [],
      },
    },
    [3],
    6,
  );

  assert.deepEqual(selection.rows.toArray(), []);
  assert.deepEqual(selection.current?.cell, [2, 3]);
  assert.deepEqual(
    selectedSequenceEditorStructuralDeleteRowIndices(selection, 6),
    [3],
  );
});

test("sequenceEditorSelectionAfterStructuralDelete selects the first row after deleting row zero", () => {
  const selection = sequenceEditorSelectionAfterStructuralDelete(
    {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: [2, 0],
        range: { x: 2, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    },
    [0],
    2,
  );

  assert.deepEqual(selection.rows.toArray(), []);
  assert.deepEqual(selection.current?.cell, [2, 0]);
  assert.deepEqual(
    selectedSequenceEditorStructuralDeleteRowIndices(selection, 2),
    [0],
  );
});

test("sequenceEditorSelectionAfterStructuralDelete prefers a deleted row over an unrelated active row", () => {
  const selection = sequenceEditorSelectionAfterStructuralDelete(
    {
      columns: CompactSelection.empty(),
      rows: CompactSelection.fromArray([2]),
      current: {
        cell: [1, 5],
        range: { x: 1, y: 5, width: 1, height: 1 },
        rangeStack: [],
      },
    },
    [2],
    7,
  );

  assert.deepEqual(selection.rows.toArray(), []);
  assert.deepEqual(selection.current?.cell, [1, 2]);
  assert.deepEqual(
    selectedSequenceEditorStructuralDeleteRowIndices(selection, 7),
    [2],
  );
});

test("sequenceEditorSelectionAfterStructuralDelete clears selection when no rows remain", () => {
  const selection = sequenceEditorSelectionAfterStructuralDelete(
    {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: [1, 0],
        range: { x: 1, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    },
    [0],
    0,
  );

  assert.deepEqual(selection.rows.toArray(), []);
  assert.equal(selection.current, undefined);
});

test("collectSequenceEditorDeleteTargets keeps cue rows and cue part rows separate", () => {
  const firstCue = cue("cue-a", 1, [10, 11]);
  const secondCue = cue("cue-b", 2, [20, 21]);
  const rows = [
    cueRow(firstCue, 0),
    partRow(firstCue, 10, 0),
    partRow(firstCue, 11, 0),
    cueRow(secondCue, 1),
    partRow(secondCue, 20, 1),
  ];

  const targets = collectSequenceEditorDeleteTargets(rows, [1, 3, 4]);

  assert.deepEqual(targets.cueSequenceIndices, [1]);
  assert.deepEqual(
    [...(targets.partTargetsByCueUid.get("cue-a")?.partIds ?? [])],
    [10],
  );
  assert.equal(targets.partTargetsByCueUid.has("cue-b"), false);
  assert.equal(targets.targetCount, 2);
});

test("collectSequenceEditorDeleteTargets ignores missing and meta rows", () => {
  const firstCue = cue("cue-a", 1, [10]);
  const metaCue = cue("setup", 0);
  const rows = [
    { ...cueRow(metaCue, 0), isSetupCue: true },
    { ...partRow(firstCue, 10, 1), isMissing: true },
  ];

  const targets = collectSequenceEditorDeleteTargets(rows, [0, 1]);

  assert.deepEqual(targets.cueSequenceIndices, []);
  assert.equal(targets.partTargetsByCueUid.size, 0);
  assert.equal(targets.targetCount, 0);
  assert.equal(canApplySequenceEditorDeleteTargets(targets), false);
});

test("collectSequenceEditorDeleteTargets blocks base part selections without the parent cue row", () => {
  const firstCue = cue("cue-a", 1, [10, 11]);
  const rows = [
    cueRow(firstCue, 0),
    { ...partRow(firstCue, 0, 0), partId: 0 },
    partRow(firstCue, 10, 0),
    partRow(firstCue, 11, 0),
  ];

  const targets = collectSequenceEditorDeleteTargets(rows, [1, 2, 3]);

  assert.deepEqual(targets.cueSequenceIndices, []);
  assert.deepEqual(
    [...(targets.partTargetsByCueUid.get("cue-a")?.partIds ?? [])],
    [10, 11],
  );
  assert.deepEqual([...targets.blockedBasePartSequenceIndices], [0]);
  assert.equal(targets.targetCount, 2);
  assert.equal(canApplySequenceEditorDeleteTargets(targets), false);
});

test("collectSequenceEditorDeleteTargets allows base part selections with the parent cue row", () => {
  const firstCue = cue("cue-a", 1, [10, 11]);
  const rows = [
    cueRow(firstCue, 0),
    { ...partRow(firstCue, 0, 0), partId: 0 },
    partRow(firstCue, 10, 0),
    partRow(firstCue, 11, 0),
  ];

  const targets = collectSequenceEditorDeleteTargets(rows, [0, 1, 2, 3]);

  assert.deepEqual(targets.cueSequenceIndices, [0]);
  assert.equal(targets.partTargetsByCueUid.size, 0);
  assert.equal(targets.blockedBasePartSequenceIndices.size, 0);
  assert.equal(targets.targetCount, 1);
  assert.equal(canApplySequenceEditorDeleteTargets(targets), true);
});

test("collectSequenceEditorDeleteTargets blocks base parts by sequence occurrence", () => {
  const repeatedCue = cue("cue-a", 1, [10]);
  const rows = [
    cueRow(repeatedCue, 0),
    { ...partRow(repeatedCue, 0, 0), partId: 0 },
    partRow(repeatedCue, 10, 0),
    cueRow(repeatedCue, 1),
    { ...partRow(repeatedCue, 0, 1), partId: 0 },
    partRow(repeatedCue, 10, 1),
  ];

  const targets = collectSequenceEditorDeleteTargets(rows, [0, 4]);

  assert.deepEqual(targets.cueSequenceIndices, [0]);
  assert.equal(targets.partTargetsByCueUid.size, 0);
  assert.deepEqual([...targets.blockedBasePartSequenceIndices], [1]);
  assert.equal(targets.targetCount, 1);
  assert.equal(canApplySequenceEditorDeleteTargets(targets), false);
});
