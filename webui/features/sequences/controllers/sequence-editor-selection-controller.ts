// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import type { GridColumn, GridSelection } from "../../../lib/data-grid-types";
import { CompactSelection } from "../../../lib/data-grid-types";
import { getSelectedRowIndices } from "../../../lib/datagrid";
import { dockApi } from "../../../state/appStores";
import type * as types from "../../../types";
import { formatCueEditorTitle } from "../../cues";
import type { SequenceEditorContextType } from "../context/sequence-editor-context";
import {
  canApplySequenceEditorDeleteTargets,
  collectSequenceEditorDeleteTargets,
  selectedSequenceEditorStructuralDeleteRowIndices,
  sequenceEditorSelectionAfterStructuralDelete,
} from "../model/sequence-editor-delete-selection";
import {
  cueBasePartToGridRow,
  cuePartToGridRow,
  editorTargetForRow,
  isMetaCueRow,
  isSequenceSummaryRow,
  isTimingColumnId,
  type SequenceEditorTarget,
  type SequenceGridRow,
  type TimingColumnId,
} from "../model/sequence-editor-model";

interface SequenceEditorSelectionControllerOptions {
  context: SequenceEditorContextType;
  rows: Accessor<SequenceGridRow[]>;
  columns: Accessor<GridColumn[]>;
  cuePartConflictIdsByCueUid: Accessor<Map<string, Set<number>>>;
}

/** Owns sequence row selection, navigation, duplication, deletion, and timing clears. */
export function createSequenceEditorSelectionController(
  options: SequenceEditorSelectionControllerOptions,
) {
  const ctx = options.context;
  const rows = options.rows;
  const columns = options.columns;
  const cuePartConflictIdsByCueUid = options.cuePartConflictIdsByCueUid;
  const $dockApi = useStore(dockApi);
  const [gridSelection, setGridSelection] = createSignal<
    GridSelection | undefined
  >(undefined);
  const [lastClickedRow, setLastClickedRow] = createSignal<number | undefined>(
    undefined,
  );
  const [selectedEditorTarget, setSelectedEditorTarget] = createSignal<
    SequenceEditorTarget | undefined
  >(undefined);
  const [pendingSelectedCueUids, setPendingSelectedCueUids] = createSignal<
    Set<string> | undefined
  >(undefined);

  /** Finds the visible row index for the context-selected cue. */
  const selectedCueIndex = createMemo(() => {
    const selectedUid = ctx.selectedCueUid();
    if (!selectedUid) return -1;
    return rows().findIndex(
      (row) => row.rowKind === "cue" && row.cueUid === selectedUid,
    );
  });

  /** Resolves the context-selected cue to its visible grid row. */
  const selectedCueRow = createMemo(() => {
    const index = selectedCueIndex();
    return index >= 0 ? rows()[index] : undefined;
  });

  /** Resolves a stable editor target even when its cue part row is collapsed. */
  const resolveEditorTarget = (
    target: SequenceEditorTarget | undefined,
  ): SequenceGridRow | undefined => {
    if (!target) return undefined;

    const visibleRow = rows().find((row) => {
      if (row.rowKind !== target.rowKind || row.cueUid !== target.cueUid) {
        return false;
      }
      return (
        target.rowKind === "cue" || row.part?.identifiers.id === target.partId
      );
    });
    if (visibleRow) return visibleRow;

    if (target.rowKind === "cue") return undefined;

    const cueRow = ctx.cueRows().find((row) => row.cueUid === target.cueUid);
    const cue = cueRow?.cue;
    const conflictingPartIds = cueRow
      ? (cuePartConflictIdsByCueUid().get(cueRow.cueUid) ?? new Set<number>())
      : new Set<number>();
    if (cueRow && cue && target.partId === 0) {
      return cueBasePartToGridRow(
        cueRow.cueUid,
        cue,
        cueRow.index,
        ctx.sequence()?.default_timing,
        {
          isSetupCue: cueRow.isSetupCue,
          isReleaseCue: cueRow.isReleaseCue,
          hasPartConflict: conflictingPartIds.has(0),
        },
      );
    }
    const partIndex = cue?.parts?.findIndex(
      (part) => part.identifiers.id === target.partId,
    );
    if (!cueRow || !cue || partIndex === undefined || partIndex < 0) {
      return undefined;
    }
    const part = cue.parts?.[partIndex];
    if (!part) return undefined;

    return cuePartToGridRow(
      cueRow.cueUid,
      cue,
      part,
      partIndex,
      cueRow.index,
      ctx.sequence()?.default_timing,
      {
        isSetupCue: cueRow.isSetupCue,
        isReleaseCue: cueRow.isReleaseCue,
        hasPartConflict: conflictingPartIds.has(part.identifiers.id),
      },
    );
  };

  /** Resolves the row targeted by toolbar and keyboard editor commands. */
  const selectedEditorRow = createMemo(() => {
    const targetRow = resolveEditorTarget(selectedEditorTarget());
    if (targetRow?.cue && !targetRow.isMissing) {
      return targetRow;
    }

    const clickedRowIndex = lastClickedRow();
    if (clickedRowIndex !== undefined) {
      const row = rows()[clickedRowIndex];
      if (row && isSequenceSummaryRow(row)) {
        return undefined;
      }
      if (row?.cue && !row.isMissing) {
        return row;
      }
    }

    const activeRow = gridSelection()?.current?.cell?.[1];
    if (activeRow !== undefined) {
      const row = rows()[activeRow];
      if (row && isSequenceSummaryRow(row)) {
        return undefined;
      }
      if (row?.cue && !row.isMissing) {
        return row;
      }
    }
    return selectedCueRow();
  });

  /** Collects movable sequence indexes from the effective grid selection. */
  const selectedMoveRows = createMemo(() => {
    const selection = gridSelection();
    const maxRows = ctx.sequence()?.steps.length ?? 0;
    const indices = new Set<number>();
    let hasExplicitGridSelection = false;

    if (selection) {
      const selectedRowIndices = getSelectedRowIndices(selection);
      hasExplicitGridSelection =
        selectedRowIndices.length > 0 || selection.current !== undefined;
      for (const rowIndex of selectedRowIndices) {
        const row = rows()[rowIndex];
        if (row?.rowKind === "cue" && !isMetaCueRow(row)) {
          indices.add(row.sequenceIndex);
        }
      }
      const range = selection.current?.range;
      if (range && range.height > 1) {
        for (
          let rowIndex = range.y;
          rowIndex < range.y + range.height;
          rowIndex++
        ) {
          const row = rows()[rowIndex];
          if (row?.rowKind === "cue" && !isMetaCueRow(row)) {
            indices.add(row.sequenceIndex);
          }
        }
      }
      const activeRow = selection.current?.cell?.[1];
      const activeGridRow =
        typeof activeRow === "number" ? rows()[activeRow] : undefined;
      if (activeGridRow?.rowKind === "cue" && !isMetaCueRow(activeGridRow)) {
        indices.add(activeGridRow.sequenceIndex);
      }
    }

    if (indices.size === 0 && !hasExplicitGridSelection) {
      const fallbackRow = selectedCueRow();
      if (fallbackRow && !isMetaCueRow(fallbackRow)) {
        indices.add(fallbackRow.sequenceIndex);
      }
    }

    return [...indices]
      .filter((rowIndex) => rowIndex >= 0 && rowIndex < maxRows)
      .sort((a, b) => a - b);
  });

  /** Collects cue identities that must remain selected after reordering. */
  const selectedMoveCueUids = createMemo(() => {
    const selectedUids = new Set<string>();
    const movableRows = ctx
      .cueRows()
      .filter((row) => !row.isSetupCue && !row.isReleaseCue);
    for (const sequenceIndex of selectedMoveRows()) {
      const row = movableRows.find((row) => row.index === sequenceIndex);
      if (row && !row.isMissing) {
        selectedUids.add(row.cueUid);
      }
    }
    return selectedUids;
  });

  /** Reapplies cue-row selection after asynchronous row reordering. */
  createEffect(() => {
    const pending = pendingSelectedCueUids();
    if (!pending || pending.size === 0) return;

    const currentRows = rows();
    const selectedIndices: number[] = [];
    for (const [index, row] of currentRows.entries()) {
      if (row.rowKind === "cue" && pending.has(row.cueUid)) {
        selectedIndices.push(index);
      }
    }

    setGridSelection((previous) => {
      const baseSelection = previous ?? {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      };
      return {
        ...baseSelection,
        rows: CompactSelection.fromArray(selectedIndices),
      };
    });
    setPendingSelectedCueUids(undefined);
  });

  /** Opens or focuses the cue editor for the effective selected row. */
  const openSelectedCueEditor = () => {
    const api = $dockApi();
    const row = selectedEditorRow();
    const cue = row?.cue;
    if (!api || !cue) return;

    const partId = row.rowKind === "part" ? (row.part?.identifiers.id ?? 0) : 0;
    const panelId = row.isSetupCue
      ? `setup-cue-editor-${ctx.sequenceUid}-p${partId}`
      : row.isReleaseCue
        ? `release-cue-editor-${ctx.sequenceUid}-p${partId}`
        : `cue-editor-${cue.identifiers.uid}-p${partId}`;
    const panel = api.getPanel(panelId);
    if (panel) {
      panel.focus();
      return;
    }

    api.addPanel({
      id: panelId,
      component: "CueEditor",
      title: formatCueEditorTitle({
        cueId: cue.identifiers.id,
        sequenceId: ctx.sequence()?.identifiers.id,
        partId,
        hasAdditionalParts: (cue.parts?.length ?? 0) > 0,
        isSetupCue: row.isSetupCue,
        isReleaseCue: row.isReleaseCue,
      }),
      params: {
        initialCueUid: cue.identifiers.uid,
        initialPartId: partId,
        initialSequenceId: ctx.sequence()?.identifiers.id,
        initialSequenceUid: ctx.sequenceUid,
        closeOnSequenceDelete: true,
        initialSetupSequenceUid: row.isSetupCue ? ctx.sequenceUid : undefined,
        initialReleaseSequenceUid: row.isReleaseCue
          ? ctx.sequenceUid
          : undefined,
      },
    });
  };

  /** Returns whether selected sequence rows can move by one position. */
  const canMoveSelection = (offset: -1 | 1) => {
    const selectedRows = selectedMoveRows();
    if (selectedRows.length === 0) return false;
    if (offset === -1) return selectedRows[0] > 0;
    return (
      selectedRows[selectedRows.length - 1] <
      (ctx.sequence()?.steps.length ?? 0) - 1
    );
  };

  /** Shifts row and range selection coordinates after a sequence reorder. */
  const shiftGridSelection = (
    selection: GridSelection,
    offset: -1 | 1,
    maxRows: number,
  ): GridSelection => {
    /** Clamps a shifted row coordinate to the current grid bounds. */
    const clamp = (value: number, min: number, max: number) =>
      Math.min(Math.max(value, min), max);
    const nextRows = getSelectedRowIndices(selection)
      .map((rowIndex) => rowIndex + offset)
      .filter((rowIndex) => rowIndex >= 0 && rowIndex < maxRows);
    const nextGridRows = CompactSelection.fromArray(nextRows);

    const current = selection.current;
    if (!current) {
      return {
        ...selection,
        rows: nextGridRows,
      };
    }

    const maxCellRow = Math.max(0, maxRows - 1);
    const shiftedCurrent = {
      ...current,
      cell: [
        current.cell[0],
        clamp(current.cell[1] + offset, 0, maxCellRow),
      ] as [number, number],
      range: current.range
        ? {
            ...current.range,
            y: clamp(
              current.range.y + offset,
              0,
              Math.max(0, maxRows - current.range.height),
            ),
          }
        : current.range,
      rangeStack: current.rangeStack.map((range) => ({
        ...range,
        y: clamp(range.y + offset, 0, Math.max(0, maxRows - range.height)),
      })),
    };

    return {
      ...selection,
      rows: nextGridRows,
      current: shiftedCurrent,
    };
  };

  /** Reorders selected cue rows while preserving their grid selection. */
  const moveSelectedCue = (offset: -1 | 1) => {
    if (!canMoveSelection(offset)) return;
    const selectedRows = selectedMoveRows();
    if (selectedRows.length === 0) return;
    const selectedCueUids = selectedMoveCueUids();

    ctx.reorderCueRows(selectedRows, offset);
    setPendingSelectedCueUids(new Set(selectedCueUids));

    const selection = gridSelection();
    if (!selection) return;
    setGridSelection(shiftGridSelection(selection, offset, rows().length));
  };

  /** Stores a grid selection and refreshes derived sequence-editor row focus state. */
  const storeGridSelection = (selection: GridSelection) => {
    setGridSelection(selection);
    const activeRow = selection.current?.cell?.[1];
    if (activeRow !== undefined) {
      setLastClickedRow(activeRow);
      const row = rows()[activeRow];
      setSelectedEditorTarget(row ? editorTargetForRow(row) : undefined);
      return;
    }

    setLastClickedRow(undefined);
    setSelectedEditorTarget(undefined);
  };

  /** Replaces stale row-delete selection with the equivalent selection in the updated row set. */
  const selectAfterDeletedRows = (
    selection: GridSelection | undefined,
    rowIndices: readonly number[],
    rowCount = rows().length,
  ): GridSelection => {
    const nextSelection = sequenceEditorSelectionAfterStructuralDelete(
      selection,
      rowIndices,
      rowCount,
    );
    storeGridSelection(nextSelection);
    return nextSelection;
  };

  /** Selects the replacement row after removing visual rows from a current row snapshot. */
  const selectAfterDeletedVisualRows = (
    selection: GridSelection | undefined,
    rowIndices: readonly number[],
    currentRows: readonly SequenceGridRow[],
  ): GridSelection => {
    const deletedRows = [...new Set(rowIndices)]
      .filter((rowIndex) => rowIndex >= 0 && rowIndex < currentRows.length)
      .sort((a, b) => a - b);
    const deletedRowSet = new Set(deletedRows);
    const postDeleteRows = currentRows.filter(
      (_, rowIndex) => !deletedRowSet.has(rowIndex),
    );
    let lastSelectableRowIndex = -1;
    for (let rowIndex = postDeleteRows.length - 1; rowIndex >= 0; rowIndex--) {
      if (!isMetaCueRow(postDeleteRows[rowIndex]!)) {
        lastSelectableRowIndex = rowIndex;
        break;
      }
    }
    return selectAfterDeletedRows(
      selection,
      deletedRows,
      lastSelectableRowIndex + 1,
    );
  };

  /** Returns rendered row indexes expected to disappear after a structural delete. */
  const deletedVisualRowIndicesForTargets = (
    deleteTargets: ReturnType<typeof collectSequenceEditorDeleteTargets>,
    currentRows: readonly SequenceGridRow[],
  ): number[] => {
    const deletedCueSequenceIndices = new Set(deleteTargets.cueSequenceIndices);
    const deletedRows = new Set<number>();

    for (const [rowIndex, row] of currentRows.entries()) {
      if (deletedCueSequenceIndices.has(row.sequenceIndex)) {
        deletedRows.add(rowIndex);
        continue;
      }

      const partTarget = deleteTargets.partTargetsByCueUid.get(row.cueUid);
      if (row.rowKind !== "part" || !partTarget) continue;

      if (row.partId !== undefined && partTarget.partIds.has(row.partId)) {
        deletedRows.add(rowIndex);
      }
    }

    return [...deletedRows].sort((a, b) => a - b);
  };

  /** Deletes all selected structural cue rows and cue-part rows. */
  const deleteSelectedGridRows = (
    rowIndices: readonly number[],
    selection: GridSelection | undefined,
  ): GridSelection | "blocked" | undefined => {
    const currentRows = rows();
    const deleteTargets = collectSequenceEditorDeleteTargets(
      currentRows,
      rowIndices,
    );
    if (deleteTargets.blockedBasePartSequenceIndices.size > 0) {
      return "blocked";
    }
    if (deleteTargets.targetCount === 0) return undefined;
    const deletedVisualRows = deletedVisualRowIndicesForTargets(
      deleteTargets,
      currentRows,
    );

    for (const { cue, partIds } of deleteTargets.partTargetsByCueUid.values()) {
      ctx.updateCue({
        ...cue,
        parts: (cue.parts ?? []).filter(
          (part) => !partIds.has(part.identifiers.id),
        ),
      });
    }

    if (deleteTargets.cueSequenceIndices.length > 0) {
      ctx.deleteCueRows(deleteTargets.cueSequenceIndices);
    }

    return selectAfterDeletedVisualRows(
      selection,
      deletedVisualRows,
      currentRows,
    );
  };

  /** Returns whether the effective selected row represents a duplicable cue. */
  const canDuplicateSelectedCue = createMemo(() => {
    const row = selectedEditorRow();
    return !!row?.cue && !isMetaCueRow(row);
  });

  /** Duplicates the selected cue when its row supports duplication. */
  const duplicateSelectedCue = () => {
    if (!canDuplicateSelectedCue()) return;
    ctx.duplicateSelectedCue();
  };

  /** Deletes selected cue or part rows and repairs selection afterward. */
  const deleteSelectedEditorRow = () => {
    const toolbarRows = selectedSequenceEditorStructuralDeleteRowIndices(
      gridSelection(),
      rows().length,
    );
    if (toolbarRows.length > 0) {
      const deleteResult = deleteSelectedGridRows(toolbarRows, gridSelection());
      if (deleteResult !== undefined) return;
    }

    const row = selectedEditorRow();
    if (!row?.cue) return;
    if (isMetaCueRow(row) && row.rowKind === "cue") return;

    if (row.rowKind === "part") {
      if (row.partId === 0) return;
      const partIndex = row.partIndex;
      if (partIndex === undefined) return;
      const currentRows = rows();
      const deletedRowIndex = currentRows.indexOf(row);
      const parts = [...(row.cue.parts ?? [])];
      if (!parts[partIndex]) return;
      parts.splice(partIndex, 1);
      ctx.updateCue({
        ...row.cue,
        parts,
      });
      selectAfterDeletedVisualRows(
        gridSelection(),
        [deletedRowIndex],
        currentRows,
      );
      return;
    }

    const selectedRows = selectedMoveRows();
    if (selectedRows.length === 0) {
      const currentRows = rows();
      const deletedVisualRows = currentRows
        .map((gridRow, rowIndex) =>
          row.cue && gridRow.cueUid === row.cue.identifiers.uid
            ? rowIndex
            : undefined,
        )
        .filter((rowIndex): rowIndex is number => rowIndex !== undefined);
      ctx.deleteSelectedCue();
      selectAfterDeletedVisualRows(
        gridSelection(),
        deletedVisualRows,
        currentRows,
      );
      return;
    }
    const currentRows = rows();
    const deletedVisualRows = currentRows
      .map((gridRow, rowIndex) =>
        selectedRows.includes(gridRow.sequenceIndex) ? rowIndex : undefined,
      )
      .filter((rowIndex): rowIndex is number => rowIndex !== undefined);
    ctx.deleteCueRows(selectedRows);
    selectAfterDeletedVisualRows(
      gridSelection(),
      deletedVisualRows,
      currentRows,
    );
  };

  /** Describes the structural delete operation for the current selection. */
  const selectedDeleteLabel = createMemo(() => {
    const selectedRows = selectedSequenceEditorStructuralDeleteRowIndices(
      gridSelection(),
      rows().length,
    );
    if (selectedRows.length > 1) return "Delete Selected Rows";
    return selectedEditorRow()?.rowKind === "part"
      ? "Delete Cue Part"
      : "Delete Cue";
  });

  /** Returns whether the effective selection has valid structural delete targets. */
  const canDeleteSelectedEditorRow = createMemo(() => {
    const selectedRows = selectedSequenceEditorStructuralDeleteRowIndices(
      gridSelection(),
      rows().length,
    );
    if (selectedRows.length > 0) {
      return canApplySequenceEditorDeleteTargets(
        collectSequenceEditorDeleteTargets(rows(), selectedRows),
      );
    }

    const row = selectedEditorRow();
    if (!row?.cue) return false;
    if (isMetaCueRow(row) && row.rowKind === "cue") return false;
    return row.rowKind === "cue" || row.partId !== 0;
  });

  /** Returns whether the sequence includes any previewable cue rows. */
  const hasPreviewableCue = createMemo(() =>
    rows().some((row) => !!row.cue && !isMetaCueRow(row)),
  );

  /** Publishes a new grid selection into derived editor targeting state. */
  const handleGridSelectionChange = (selection: GridSelection) => {
    storeGridSelection(selection);
  };

  /** Clears selected cue and part timing overrides in one operation. */
  const clearTimingOverridesForSelection = (
    selection: GridSelection | undefined,
  ): boolean => {
    if (!selection) return false;

    const selectedTimingCellsByCue = new Map<
      string,
      {
        cue: types.Cue;
        cueFields: Set<TimingColumnId>;
        partFieldsByIndex: Map<number, Set<TimingColumnId>>;
      }
    >();
    const currentRows = rows();
    const currentColumns = columns();

    /** Returns the accumulated timing-clear entry for one cue. */
    const timingEntryForCue = (cue: types.Cue) => {
      const cueUid = cue.identifiers.uid;
      const existing = selectedTimingCellsByCue.get(cueUid);
      if (existing) return existing;
      const entry = {
        cue,
        cueFields: new Set<TimingColumnId>(),
        partFieldsByIndex: new Map<number, Set<TimingColumnId>>(),
      };
      selectedTimingCellsByCue.set(cueUid, entry);
      return entry;
    };

    /** Adds one timing field coordinate to the cue-level clear operation. */
    const addTimingField = (rowIndex: number, columnId: string | undefined) => {
      const rowData = currentRows[rowIndex];
      if (!rowData?.cue || rowData.isMissing) return;
      if (!isTimingColumnId(columnId)) return;

      if (rowData.rowKind === "part" && rowData.partId === 0) {
        timingEntryForCue(rowData.cue).cueFields.add(columnId);
      } else if (
        rowData.rowKind === "part" &&
        rowData.partIndex !== undefined
      ) {
        const entry = timingEntryForCue(rowData.cue);
        const fields =
          entry.partFieldsByIndex.get(rowData.partIndex) ?? new Set();
        fields.add(columnId);
        entry.partFieldsByIndex.set(rowData.partIndex, fields);
      } else {
        timingEntryForCue(rowData.cue).cueFields.add(columnId);
      }
    };

    for (const rowIndex of selection.rows) {
      for (const column of currentColumns) {
        addTimingField(
          rowIndex,
          typeof column.id === "string" ? column.id : undefined,
        );
      }
    }

    const ranges = selection.current
      ? [selection.current.range, ...selection.current.rangeStack]
      : [];

    for (const range of ranges) {
      for (
        let rowIndex = range.y;
        rowIndex < range.y + range.height;
        rowIndex++
      ) {
        for (
          let columnIndex = range.x;
          columnIndex < range.x + range.width;
          columnIndex++
        ) {
          addTimingField(rowIndex, currentColumns[columnIndex]?.id);
        }
      }
    }

    if (selectedTimingCellsByCue.size === 0) {
      return false;
    }

    for (const {
      cue,
      cueFields,
      partFieldsByIndex,
    } of selectedTimingCellsByCue.values()) {
      const transitions = { ...cue.transitions };
      for (const field of cueFields) {
        delete transitions[field];
      }
      const parts = [...(cue.parts ?? [])];
      for (const [partIndex, fields] of partFieldsByIndex) {
        const part = parts[partIndex];
        if (!part) continue;

        const partTransitions = { ...part.transitions };
        for (const field of fields) {
          delete partTransitions[field];
        }
        parts[partIndex] = {
          ...part,
          transitions: partTransitions,
        };
      }

      ctx.updateCue({
        ...cue,
        transitions,
        parts,
      });
    }

    return true;
  };

  return {
    canDeleteSelectedEditorRow,
    canDuplicateSelectedCue,
    canMoveSelection,
    clearTimingOverridesForSelection,
    deleteSelectedEditorRow,
    duplicateSelectedCue,
    gridSelection,
    handleGridSelectionChange,
    hasPreviewableCue,
    moveSelectedCue,
    openSelectedCueEditor,
    selectedDeleteLabel,
    selectedEditorRow,
    setLastClickedRow,
    setSelectedEditorTarget,
  };
}
