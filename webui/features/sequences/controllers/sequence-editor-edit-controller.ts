// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Accessor } from "solid-js";
import type { DataGridCellEdit } from "../../../components/widgets/data-grid";
import type {
  GridCell,
  GridColumn,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import { getRowsToEdit } from "../../../lib/datagrid";
import { isDropdownCell } from "../../../lib/tanstack-dropdown-cell";
import type * as types from "../../../types";
import { isTrackingFlagsCell, trackingFlagsFromIds } from "../../cue-sequences";
import type { SequenceEditorContextType } from "../context/sequence-editor-context";
import {
  canEditTriggerDuration,
  cueWithTrackingCellEdit,
  isMetaCueRow,
  isTimeCell,
  isTimingColumnId,
  type SequenceGridRow,
  updateCueTriggerType,
} from "../model/sequence-editor-model";
import { triggerDurationEdit } from "../model/sequence-wrap-delay";

interface SequenceEditorEditControllerOptions {
  context: SequenceEditorContextType;
  rows: Accessor<SequenceGridRow[]>;
  columns: Accessor<GridColumn[]>;
  gridSelection: Accessor<GridSelection | undefined>;
}

/** Owns single-cell and batch edits for sequence cue and part rows. */
export function createSequenceEditorEditController(
  options: SequenceEditorEditControllerOptions,
) {
  const ctx = options.context;
  const rows = options.rows;
  const columns = options.columns;
  const gridSelection = options.gridSelection;

  /** Applies one concrete grid edit to a cue snapshot without publishing it. */
  const applyConcreteCellEdit = (
    cue: types.Cue,
    rowData: SequenceGridRow,
    columnId: string | undefined,
    newCell: GridCell,
  ): types.Cue | undefined => {
    if (rowData.rowKind === "part" && rowData.partId !== 0) {
      const partIndex = rowData.partIndex;
      if (partIndex === undefined) return undefined;
      const parts = [...(cue.parts ?? [])];
      const part = parts[partIndex];
      if (!part) return undefined;

      if (isTimingColumnId(columnId)) {
        if (!isTimeCell(newCell)) return undefined;
        const transitions = { ...part.transitions };
        if (newCell.data.cleared === true) {
          delete transitions[columnId];
        } else {
          transitions[columnId] = {
            type: "Fixed",
            data: newCell.data.value,
          };
        }
        parts[partIndex] = {
          ...part,
          transitions,
        };
        return {
          ...cue,
          parts,
        };
      }

      if (columnId === "tracking") {
        if (!isTrackingFlagsCell(newCell)) {
          return undefined;
        }
        parts[partIndex] = {
          ...part,
          tracking_flags: trackingFlagsFromIds(newCell.data.selectedIds),
        };
        return {
          ...cue,
          parts,
        };
      }

      if (columnId === "lookahead") {
        if (newCell.kind !== GridCellKind.Boolean) {
          return undefined;
        }
        parts[partIndex] = {
          ...part,
          lookahead: newCell.data === true,
        };
        return {
          ...cue,
          parts,
        };
      }

      if (columnId !== "label" || newCell.kind !== GridCellKind.Text) {
        return undefined;
      }
      parts[partIndex] = {
        ...part,
        identifiers: {
          ...part.identifiers,
          label: newCell.data.trim(),
        },
      };
      return {
        ...cue,
        parts,
      };
    }

    if (columnId === "tracking") {
      if (!isTrackingFlagsCell(newCell)) {
        return undefined;
      }
      return cueWithTrackingCellEdit(cue, newCell);
    }

    if (columnId === "lookahead") {
      if (newCell.kind !== GridCellKind.Boolean) {
        return undefined;
      }
      return {
        ...cue,
        lookahead: newCell.data === true,
      };
    }

    if (columnId === "trigger") {
      if (rowData.isFirstSequenceCue) return undefined;
      if (!isDropdownCell(newCell)) return undefined;
      const triggerType = newCell.data.value as
        | types.CueTriggerType["type"]
        | undefined
        | null;
      if (!triggerType) return undefined;
      return updateCueTriggerType(cue, triggerType);
    }

    if (columnId === "after_delay") {
      if (
        !isTimeCell(newCell) ||
        rowData.rowKind !== "cue" ||
        !canEditTriggerDuration(rowData)
      ) {
        return undefined;
      }
      return {
        ...cue,
        trigger: triggerDurationEdit(
          cue.trigger,
          newCell.data.value,
          !!rowData.isWrapDelayCue,
        ),
      };
    }

    if (isTimingColumnId(columnId)) {
      if (!isTimeCell(newCell)) return undefined;
      const transitions = { ...cue.transitions };
      if (newCell.data.cleared === true) {
        delete transitions[columnId];
      } else {
        transitions[columnId] = {
          type: "Fixed",
          data: newCell.data.value,
        };
      }
      return {
        ...cue,
        transitions,
      };
    }

    if (
      newCell.kind !== GridCellKind.Text &&
      newCell.kind !== GridCellKind.Number
    ) {
      return undefined;
    }

    const rawValue =
      newCell.kind === GridCellKind.Number
        ? newCell.data.toString()
        : newCell.data;
    const value = rawValue.trim();

    if (columnId === "label") {
      return {
        ...cue,
        identifiers: {
          ...cue.identifiers,
          label: value,
        },
      };
    }

    return undefined;
  };

  /** Applies a multi-cell edit as one merged cue update per affected cue. */
  const onCellsEdited = (
    edits: readonly DataGridCellEdit[],
    selection?: GridSelection,
  ) => {
    const pendingCues = new Map<string, types.Cue>();
    const commitSelection = selection ?? gridSelection();

    for (const { cell, newValue } of edits) {
      const [col, row] = cell;
      const rowData = rows()[row];
      const column = columns()[col];
      if (!rowData || !column || !rowData.cue || rowData.isMissing) continue;
      const columnId = typeof column.id === "string" ? column.id : undefined;

      if (columnId === "after_delay" && isTimeCell(newValue)) {
        const targetRowIndices = new Set([
          row,
          ...getRowsToEdit(commitSelection, col, row, rows().length),
        ]);
        for (const targetRowIndex of targetRowIndices) {
          const targetRow = rows()[targetRowIndex];
          if (
            !targetRow?.cue ||
            targetRow.isMissing ||
            targetRow.rowKind !== "cue" ||
            !canEditTriggerDuration(targetRow)
          ) {
            continue;
          }

          const cue = pendingCues.get(targetRow.cueUid) ?? targetRow.cue;
          pendingCues.set(targetRow.cueUid, {
            ...cue,
            trigger: triggerDurationEdit(
              cue.trigger,
              newValue.data.value,
              !!targetRow.isWrapDelayCue,
            ),
          });
        }
        continue;
      }

      const cue = pendingCues.get(rowData.cueUid) ?? rowData.cue;
      const updatedCue = applyConcreteCellEdit(
        cue,
        rowData,
        columnId,
        newValue,
      );
      if (updatedCue) {
        pendingCues.set(rowData.cueUid, updatedCue);
      }
    }

    const batchId = pendingCues.size > 1 ? crypto.randomUUID() : undefined;
    for (const cue of pendingCues.values()) {
      ctx.updateCue(cue, batchId);
    }
  };

  /** Applies a single grid edit, including selected-row expansion for Trigger After cells. */
  const onCellEdited = (
    [col, row]: Item,
    newCell: GridCell,
    selection?: GridSelection,
  ) => {
    const rowData = rows()[row];
    const column = columns()[col];
    if (!rowData || !column || !rowData.cue || rowData.isMissing) return;

    const cue = rowData.cue;
    const columnId = column.id;

    if (rowData.rowKind === "part" && rowData.partId !== 0) {
      const partIndex = rowData.partIndex;
      if (partIndex === undefined) return;
      const parts = [...(cue.parts ?? [])];
      const part = parts[partIndex];
      if (!part) return;

      if (isTimingColumnId(columnId)) {
        if (!isTimeCell(newCell)) return;
        const transitions = { ...part.transitions };
        if (newCell.data.cleared === true) {
          delete transitions[columnId];
        } else {
          transitions[columnId] = {
            type: "Fixed",
            data: newCell.data.value,
          };
        }
        parts[partIndex] = {
          ...part,
          transitions,
        };
        ctx.updateCue({
          ...cue,
          parts,
        });
        return;
      }

      if (columnId === "tracking") {
        if (!isTrackingFlagsCell(newCell)) return;
        parts[partIndex] = {
          ...part,
          tracking_flags: trackingFlagsFromIds(newCell.data.selectedIds),
        };
        ctx.updateCue({
          ...cue,
          parts,
        });
        return;
      }

      if (columnId === "lookahead") {
        if (newCell.kind !== GridCellKind.Boolean) return;
        parts[partIndex] = {
          ...part,
          lookahead: newCell.data === true,
        };
        ctx.updateCue({
          ...cue,
          parts,
        });
        return;
      }

      if (columnId !== "label" || newCell.kind !== GridCellKind.Text) return;
      parts[partIndex] = {
        ...part,
        identifiers: {
          ...part.identifiers,
          label: newCell.data.trim(),
        },
      };
      ctx.updateCue({
        ...cue,
        parts,
      });
      return;
    }

    if (columnId === "tracking") {
      if (!isTrackingFlagsCell(newCell)) return;
      ctx.updateCue(cueWithTrackingCellEdit(cue, newCell));
      return;
    }

    if (columnId === "lookahead") {
      if (newCell.kind !== GridCellKind.Boolean) return;
      ctx.updateCue({
        ...cue,
        lookahead: newCell.data === true,
      });
      return;
    }

    if (columnId === "trigger") {
      if (isMetaCueRow(rowData) || rowData.isFirstSequenceCue) return;
      if (!isDropdownCell(newCell)) return;
      const triggerType = newCell.data.value as
        | types.CueTriggerType["type"]
        | undefined
        | null;
      if (!triggerType) return;
      const rowsToEdit = new Set([
        row,
        ...getRowsToEdit(selection ?? gridSelection(), col, row, rows().length),
      ]);
      const batchId = rowsToEdit.size > 1 ? crypto.randomUUID() : undefined;
      const editedCueUids = new Set<string>();
      for (const targetRowIndex of rowsToEdit) {
        const targetRow = rows()[targetRowIndex];
        if (
          !targetRow?.cue ||
          targetRow.isMissing ||
          targetRow.rowKind !== "cue" ||
          isMetaCueRow(targetRow) ||
          targetRow.isFirstSequenceCue ||
          editedCueUids.has(targetRow.cueUid)
        ) {
          continue;
        }
        editedCueUids.add(targetRow.cueUid);
        ctx.updateCue(
          updateCueTriggerType(targetRow.cue, triggerType),
          batchId,
        );
      }
      return;
    }

    if (columnId === "after_delay") {
      if (!isTimeCell(newCell)) return;
      const rowsToEdit = new Set([
        row,
        ...getRowsToEdit(selection ?? gridSelection(), col, row, rows().length),
      ]);
      const batchId = rowsToEdit.size > 1 ? crypto.randomUUID() : undefined;
      const editedCueUids = new Set<string>();
      for (const targetRowIndex of rowsToEdit) {
        const targetRow = rows()[targetRowIndex];
        if (
          !targetRow?.cue ||
          targetRow.isMissing ||
          !canEditTriggerDuration(targetRow) ||
          editedCueUids.has(targetRow.cueUid)
        ) {
          continue;
        }
        editedCueUids.add(targetRow.cueUid);
        ctx.updateCue(
          {
            ...targetRow.cue,
            trigger: triggerDurationEdit(
              targetRow.cue.trigger,
              newCell.data.value,
              !!targetRow.isWrapDelayCue,
            ),
          },
          batchId,
        );
      }
      return;
    }

    if (isTimingColumnId(columnId)) {
      if (!isTimeCell(newCell)) return;
      if (newCell.data.cleared === true) {
        const transitions = { ...cue.transitions };
        delete transitions[columnId];
        ctx.updateCue({
          ...cue,
          transitions,
        });
        return;
      }

      const mode: types.TransitionMode = {
        type: "Fixed",
        data: newCell.data.value,
      };
      ctx.updateCue({
        ...cue,
        transitions: {
          ...cue.transitions,
          [columnId]: mode,
        },
      });
      return;
    }

    if (
      newCell.kind !== GridCellKind.Text &&
      newCell.kind !== GridCellKind.Number
    ) {
      return;
    }

    const rawValue =
      newCell.kind === GridCellKind.Number
        ? newCell.data.toString()
        : newCell.data;
    const value = rawValue.trim();

    switch (columnId) {
      case "label": {
        ctx.updateCue({
          ...cue,
          identifiers: {
            ...cue.identifiers,
            label: value,
          },
        });
        break;
      }
      default:
        break;
    }
  };

  return {
    onCellEdited,
    onCellsEdited,
  };
}
