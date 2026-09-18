// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Accessor } from "solid-js";
import {
  type DataGridCellEdit,
  type DataGridEditCommitContext,
  selectedClipboardCells,
} from "../../../components/widgets/data-grid";
import { editGroupedInstructionValue } from "../../../lib/cue-instruction-edit";
import {
  deleteInstructionAttributeTiming,
  deleteInstructionFixtureAttributeTiming,
  type TimingField,
  transitionForFixtureAttribute,
  upsertInstructionFixtureAttributeTiming,
} from "../../../lib/cue-timing-values";
import type {
  GridCell,
  GridColumn,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import { getRowsToEdit } from "../../../lib/datagrid";
import { fixtureRefKey } from "../../../lib/selection-resolution";
import {
  parseTimingFanInput,
  resolveTimingFanDuration,
} from "../../../lib/timing-fan";
import {
  assertionStyleForMarkerEdit,
  convertValueSourceAssertionStyle,
  parseValueSourceEditResult,
} from "../../../lib/value-source";
import type * as types from "../../../types";
import type { CueEditorContextType } from "../context/cue-editor-context";
import {
  applyFixedTimingToFanMember,
  type CueFixtureRow,
  type CueGridColumn,
  type CueInstructionRowTarget,
  type DisplayMode,
  instructionForFixtureRefEdit,
  isTimeCell,
  normalizedAttributeKey,
  rowCoveredByParentTargets,
  TIMING_FAN_TOOLTIP,
  type TimingClearScope,
  type TimingFanEditMember,
  type TimingFanEditMode,
  type TimingFanEditResult,
  timingClearTargetsForRowAttribute,
  timingColumnForGridColumn,
  timingEditTargetKey,
  timingTargetsForRowAttribute,
  valueTargetsForRowAttribute,
} from "../model/cue-editor-model";

interface CueEditorEditControllerOptions {
  context: CueEditorContextType;
  displayMode: Accessor<DisplayMode>;
  gridSelection: Accessor<GridSelection | undefined>;
  lastClickedCell: Accessor<Item | undefined>;
  flatRows: Accessor<CueFixtureRow[]>;
  columns: Accessor<CueGridColumn[]>;
  commitCueUpdate: (cue: types.Cue) => void;
}

/** Owns cue value edits, timing fan edits, and timing-clear commands. */
export function createCueEditorEditController(
  options: CueEditorEditControllerOptions,
) {
  const ctx = options.context;
  const displayMode = options.displayMode;
  const gridSelection = options.gridSelection;
  const lastClickedCell = options.lastClickedCell;
  const flatRows = options.flatRows;
  const columns = options.columns;
  const commitCueUpdate = options.commitCueUpdate;

  const applyCellEditToCue = (
    updatedCue: types.Cue,
    rows: readonly CueFixtureRow[],
    cols: readonly GridColumn[],
    [col, row]: Item,
    newCell: GridCell,
    options: { expandSelection: boolean },
  ): boolean => {
    if (!rows[row]) return false;

    const column = cols[col];
    const rowsToEdit = options.expandSelection
      ? getRowsToEdit(gridSelection(), col, row, rows.length)
      : [row];
    let changed = false;

    for (const targetRow of rowsToEdit) {
      const fixture = rows[targetRow];

      if (displayMode() === "values") {
        if (ctx.isReleaseCue) return false;
        const value =
          newCell.kind === GridCellKind.Text
            ? newCell.data
            : newCell.kind === GridCellKind.Number
              ? (newCell.data?.toString() ?? "")
              : null;
        if (value === null || value === undefined) continue;

        const cueColumn = column as CueGridColumn | undefined;
        if (cueColumn?.cueColumnKind === "value" && cueColumn.cueAttribute) {
          const attr = cueColumn.cueAttribute;
          const valueTargets = valueTargetsForRowAttribute(fixture, attr);
          if (valueTargets.length === 0) continue;

          const trimmedValue = value.trim();
          const assertionStyle = assertionStyleForMarkerEdit(value);
          const isMarkerEdit = /^(r|h|b)$/i.test(trimmedValue);
          const editValue =
            assertionStyle === undefined &&
            !isMarkerEdit &&
            fixture.attributes.rel[attr] !== undefined &&
            trimmedValue !== "" &&
            !trimmedValue.startsWith("~") &&
            !trimmedValue.startsWith("@")
              ? `~${value}`
              : value;
          const parseResult =
            assertionStyle === undefined
              ? parseValueSourceEditResult(editValue)
              : undefined;
          if (parseResult?.type === "Invalid") continue;

          for (const target of valueTargets) {
            const targetInstructionContainer =
              target.partIndex === undefined
                ? updatedCue.instructions
                : updatedCue.parts?.[target.partIndex]?.instructions;
            if (
              parseResult?.type === "Valid" &&
              editGroupedInstructionValue(
                targetInstructionContainer?.[target.selectionIndex],
                target.fixtureRef,
                attr,
                parseResult.source,
              )
            ) {
              changed = true;
              continue;
            }
            const instructionItem = instructionForFixtureRefEdit(
              targetInstructionContainer,
              target.selectionIndex,
              target.fixtureRef,
              { create: parseResult?.type === "Valid" },
            );
            if (!instructionItem) continue;

            const { cue_instruction: instruction } = instructionItem;
            if (assertionStyle !== undefined) {
              const valueKey = normalizedAttributeKey(instruction.values, attr);
              const convertedSource = convertValueSourceAssertionStyle(
                valueKey ? instruction.values?.[valueKey] : undefined,
                assertionStyle,
              );
              if (!valueKey || !convertedSource) continue;
              instruction.values = {
                ...instruction.values,
                [valueKey]: convertedSource,
              };
              changed = true;
              continue;
            }
            if (!parseResult) continue;

            if (!instruction.values) {
              instruction.values = {};
            }

            if (parseResult.type === "Empty") {
              delete instruction.values[attr];
              changed = true;
              continue;
            }

            instruction.values[attr] = parseResult.source;
            changed = true;
          }
        }
      } else {
        const timingColumn = timingColumnForGridColumn(column);
        if (timingColumn) {
          if (!isTimeCell(newCell)) continue;
          const { attr, field } = timingColumn;
          const timingTargets = timingTargetsForRowAttribute(fixture, attr);
          if (timingTargets.length === 0) continue;

          if (newCell.data.cleared === true) {
            for (const target of timingClearTargetsForRowAttribute(
              fixture,
              attr,
            )) {
              const targetInstructionContainer =
                target.partIndex === undefined
                  ? updatedCue.instructions
                  : updatedCue.parts?.[target.partIndex]?.instructions;
              const instruction =
                targetInstructionContainer?.[target.selectionIndex]
                  ?.cue_instruction;
              if (!instruction) continue;
              if (
                transitionForFixtureAttribute(
                  instruction,
                  target.fixtureRef,
                  attr,
                )?.[field]
              ) {
                deleteInstructionFixtureAttributeTiming(
                  instruction,
                  target.fixtureRef,
                  attr,
                  field,
                );
              } else {
                deleteInstructionAttributeTiming(instruction, attr, field);
              }
              changed = true;
            }
          } else {
            for (const target of timingTargets) {
              const targetInstructionContainer =
                target.partIndex === undefined
                  ? updatedCue.instructions
                  : updatedCue.parts?.[target.partIndex]?.instructions;
              const instruction =
                targetInstructionContainer?.[target.selectionIndex]
                  ?.cue_instruction;
              if (!instruction) continue;
              upsertInstructionFixtureAttributeTiming(
                instruction,
                target.fixtureRef,
                attr,
                field,
                {
                  type: "Fixed",
                  data: newCell.data.value,
                },
              );
              changed = true;
            }
          }
        }
      }
    }

    return changed;
  };

  /** Applies one group of fan members to the selected timing field. */
  const applyTimingFanMembers = (
    updatedCue: types.Cue,
    members: readonly TimingFanEditMember[],
    attr: string,
    field: TimingField,
    fanDurations: readonly types.Duration[],
  ): boolean => {
    let changed = false;
    const validMembers = members.filter((member) => member.targets.length > 0);
    for (const [offset, member] of validMembers.entries()) {
      changed =
        applyFixedTimingToFanMember(
          updatedCue,
          member,
          attr,
          field,
          resolveTimingFanDuration(fanDurations, offset, validMembers.length),
        ) || changed;
    }
    return changed;
  };

  /** Builds fan members for the selected rows using literal visible-row semantics. */
  const timingFanMembersAcrossRows = (
    selectedRows: readonly CueFixtureRow[],
    attr: string,
  ): TimingFanEditMember[] => {
    const parentTargetKeys = new Set<string>();
    for (const row of selectedRows) {
      if (row.type !== "parent" || row.selectedElementRows.length === 0) {
        continue;
      }
      for (const target of timingTargetsForRowAttribute(row, attr)) {
        parentTargetKeys.add(timingEditTargetKey(target));
      }
    }

    return selectedRows.flatMap((row) => {
      if (
        row.type !== "parent" &&
        rowCoveredByParentTargets(row, attr, parentTargetKeys)
      ) {
        return [];
      }
      const targets = timingTargetsForRowAttribute(row, attr);
      return targets.length > 0 ? [{ targets }] : [];
    });
  };

  /** Applies a grouped fan where each selected parent receives its own internal fan. */
  const applyTimingFanWithinGroups = (
    updatedCue: types.Cue,
    selectedRows: readonly CueFixtureRow[],
    attr: string,
    field: TimingField,
    fanDurations: readonly types.Duration[],
  ): boolean => {
    let changed = false;
    const parentTargetKeys = new Set<string>();
    for (const row of selectedRows) {
      if (row.type !== "parent" || row.selectedElementRows.length === 0) {
        continue;
      }
      const members = row.selectedElementRows
        .map((elementRow) => ({
          targets: timingTargetsForRowAttribute(elementRow, attr),
        }))
        .filter((member) => member.targets.length > 0);
      for (const member of members) {
        for (const target of member.targets) {
          parentTargetKeys.add(timingEditTargetKey(target));
        }
      }
      changed =
        applyTimingFanMembers(updatedCue, members, attr, field, fanDurations) ||
        changed;
    }

    const looseMembers = selectedRows.flatMap((row) => {
      if (row.type === "parent" && row.selectedElementRows.length > 0) {
        return [];
      }
      if (rowCoveredByParentTargets(row, attr, parentTargetKeys)) {
        return [];
      }
      const targets = timingTargetsForRowAttribute(row, attr);
      return targets.length > 0 ? [{ targets }] : [];
    });

    return (
      applyTimingFanMembers(
        updatedCue,
        looseMembers,
        attr,
        field,
        fanDurations,
      ) || changed
    );
  };

  /** Applies a parsed timing fan edit to the supplied concrete grid cells. */
  const applyTimingFanEditToCue = (
    updatedCue: types.Cue,
    rows: readonly CueFixtureRow[],
    cols: readonly GridColumn[],
    cells: readonly Item[],
    inputValue: string | undefined,
    mode: TimingFanEditMode,
  ): TimingFanEditResult => {
    if (!inputValue || displayMode() !== "timings") return "not-fan";
    if (!inputValue.includes(">")) return "not-fan";
    const fanDurations = parseTimingFanInput(inputValue);
    if (!fanDurations) return "invalid";

    let changed = false;
    const cellsByColumn = new Map<number, Item[]>();
    for (const cell of cells) {
      const [col, row] = cell;
      if (!rows[row]) continue;
      const timingColumn = timingColumnForGridColumn(cols[col]);
      if (!timingColumn) continue;
      if (!rows[row].applicableAttributes.has(timingColumn.attr)) continue;
      const columnCells = cellsByColumn.get(col) ?? [];
      columnCells.push(cell);
      cellsByColumn.set(col, columnCells);
    }

    for (const [col, columnCells] of cellsByColumn) {
      const timingColumn = timingColumnForGridColumn(cols[col]);
      if (!timingColumn) continue;
      const orderedRows = columnCells
        .map(([, row]) => rows[row])
        .filter((row): row is CueFixtureRow => row !== undefined);
      if (mode === "within-groups") {
        changed =
          applyTimingFanWithinGroups(
            updatedCue,
            orderedRows,
            timingColumn.attr,
            timingColumn.field,
            fanDurations,
          ) || changed;
        continue;
      }

      changed =
        applyTimingFanMembers(
          updatedCue,
          timingFanMembersAcrossRows(orderedRows, timingColumn.attr),
          timingColumn.attr,
          timingColumn.field,
          fanDurations,
        ) || changed;
    }

    return changed ? "changed" : "unchanged";
  };

  /** Applies a grid cell edit to cue values or per-fixture timing overrides. */
  const onCellEdited = (
    cell: Item,
    newCell: GridCell,
    selection?: GridSelection,
    context?: DataGridEditCommitContext,
  ) => {
    const currentCue = ctx.cue();
    const rows = flatRows();
    const cols = columns();

    if (!currentCue) return;

    const updatedCue: types.Cue = JSON.parse(JSON.stringify(currentCue));
    const [col, row] = cell;
    const fanCells = getRowsToEdit(
      selection ?? gridSelection(),
      col,
      row,
      rows.length,
    ).map((targetRow): Item => [col, targetRow]);
    const fanResult = applyTimingFanEditToCue(
      updatedCue,
      rows,
      cols,
      fanCells,
      context?.inputValue,
      context?.mode === "alternate" ? "within-groups" : "across-rows",
    );
    if (fanResult === "changed") {
      commitCueUpdate(updatedCue);
      return;
    }
    if (fanResult !== "not-fan") return;

    const changed = applyCellEditToCue(updatedCue, rows, cols, cell, newCell, {
      expandSelection: true,
    });
    if (!changed) return;

    commitCueUpdate(updatedCue);
  };

  /** Applies multiple concrete grid edits with one cue commit and preview refresh. */
  const onCellsEdited = (
    edits: readonly DataGridCellEdit[],
    _selection?: GridSelection,
    context?: DataGridEditCommitContext,
  ) => {
    const currentCue = ctx.cue();
    const rows = flatRows();
    const cols = columns();

    if (!currentCue || edits.length === 0) return;

    const updatedCue: types.Cue = JSON.parse(JSON.stringify(currentCue));
    const fanInput = context?.inputValue ?? edits[0]?.inputValue;
    const fanMode =
      (context?.mode ?? edits[0]?.commitMode) === "alternate"
        ? "within-groups"
        : "across-rows";
    const fanResult = applyTimingFanEditToCue(
      updatedCue,
      rows,
      cols,
      edits.map((edit) => edit.cell),
      fanInput,
      fanMode,
    );
    if (fanResult === "changed") {
      commitCueUpdate(updatedCue);
      return;
    }
    if (fanResult !== "not-fan") return;

    let changed = false;
    for (const edit of edits) {
      changed =
        applyCellEditToCue(updatedCue, rows, cols, edit.cell, edit.newValue, {
          expandSelection: false,
        }) || changed;
    }
    if (!changed) return;

    commitCueUpdate(updatedCue);
  };

  /** Returns inline edit guidance for cue timing fan expressions. */
  const inlineEditTooltip = (context: { cell: GridCell; value: string }) =>
    displayMode() === "timings" &&
    isTimeCell(context.cell) &&
    context.value.includes(">")
      ? TIMING_FAN_TOOLTIP
      : undefined;

  /** Clears timing overrides from the selected timing cells. */
  const clearTimingOverridesForSelection = (
    selection: GridSelection | undefined,
    scope: TimingClearScope = "parent",
  ): boolean => {
    const currentCue = ctx.cue();
    const fallbackCell = lastClickedCell();
    if (
      !currentCue ||
      displayMode() !== "timings" ||
      (!selection && !fallbackCell)
    ) {
      return false;
    }

    const selectedTimingCells = new Map<
      string,
      {
        selectionIndex: number;
        partIndex?: number;
        fixtureRef: types.FixtureRef;
        attr: string;
        fields: Set<TimingField>;
      }
    >();
    const currentRows = flatRows();
    const currentColumns = columns();
    /** Adds one concrete timing clear target into the clear-operation set. */
    const addSelectedTimingTarget = (
      target: CueInstructionRowTarget,
      attr: string,
      field: TimingField,
    ) => {
      const partKey = target.partIndex ?? "parent";
      const key = `${partKey}:${target.selectionIndex}:${fixtureRefKey(target.fixtureRef)}:${attr}`;
      const selected = selectedTimingCells.get(key) ?? {
        selectionIndex: target.selectionIndex,
        partIndex: target.partIndex,
        fixtureRef: target.fixtureRef,
        attr,
        fields: new Set<TimingField>(),
      };
      selected.fields.add(field);
      selectedTimingCells.set(key, selected);
    };

    /** Adds a timing cell from grid coordinates into the clear-operation set. */
    const addSelectedTimingCell = (columnIndex: number, rowIndex: number) => {
      const rowData = currentRows[rowIndex];
      if (!rowData) return;
      const timingColumn = timingColumnForGridColumn(
        currentColumns[columnIndex],
      );
      if (!timingColumn) return;
      for (const target of timingClearTargetsForRowAttribute(
        rowData,
        timingColumn.attr,
        scope,
      )) {
        addSelectedTimingTarget(target, timingColumn.attr, timingColumn.field);
      }
    };

    if (selection) {
      for (const [columnIndex, rowIndex] of selectedClipboardCells(
        selection,
        currentRows.length,
        currentColumns.length,
      )) {
        addSelectedTimingCell(columnIndex, rowIndex);
      }
    }
    if (selectedTimingCells.size === 0 && fallbackCell) {
      addSelectedTimingCell(fallbackCell[0], fallbackCell[1]);
    }

    if (selectedTimingCells.size === 0) return false;

    const updatedCue: types.Cue = JSON.parse(JSON.stringify(currentCue));
    for (const selected of selectedTimingCells.values()) {
      const instructionContainer =
        selected.partIndex === undefined
          ? updatedCue.instructions
          : updatedCue.parts?.[selected.partIndex]?.instructions;
      const instruction =
        instructionContainer?.[selected.selectionIndex]?.cue_instruction;
      if (!instruction) continue;
      for (const field of selected.fields) {
        if (
          transitionForFixtureAttribute(
            instruction,
            selected.fixtureRef,
            selected.attr,
          )?.[field]
        ) {
          deleteInstructionFixtureAttributeTiming(
            instruction,
            selected.fixtureRef,
            selected.attr,
            field,
          );
        } else {
          deleteInstructionAttributeTiming(instruction, selected.attr, field);
        }
      }
    }

    commitCueUpdate(updatedCue);
    return true;
  };

  return {
    clearTimingOverridesForSelection,
    inlineEditTooltip,
    onCellEdited,
    onCellsEdited,
  };
}
