// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowUUpLeftIcon } from "@squidlab/phosphor-solid/arrow-u-up-left";
import { EraserIcon } from "@squidlab/phosphor-solid/eraser";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import type { Accessor } from "solid-js";
import {
  type ContextMenuEntry,
  openContextMenu,
} from "../../../components/providers/context-menu";
import { selectedClipboardCells } from "../../../components/widgets/data-grid";
import type {
  GridSelection,
  GroupHeaderClickedEventArgs,
  Item,
} from "../../../lib/data-grid-types";
import { CompactSelection } from "../../../lib/data-grid-types";
import { getSelectedRowIndices } from "../../../lib/datagrid";
import type { RichTimeDisplayUnit } from "../../../lib/datagrid-rich-cells";
import { fixtureRefKey } from "../../../lib/selection-resolution";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { normalizeAttributeName } from "../../../lib/utils";
import { blueprints as blueprintStore } from "../../../state/appStores";
import type * as types from "../../../types";
import { selectedBlueprintValues } from "../../blueprints";
import {
  selectedTimeDisplayColumnIds,
  timeUnitContextMenuEntries,
} from "../../cue-sequences";
import type { CueEditorContextType } from "../context/cue-editor-context";
import {
  makeBlueprintInstructionsAbsolute,
  type ReferencedBlueprintInstructionTarget,
} from "../model/cue-editor-blueprint-model";
import {
  attributeForGridColumn,
  type CueFixtureRow,
  type CueGridColumn,
  type DisplayMode,
  deleteInstructionAttribute,
  deleteInstructionAttributeValues,
  instructionContainerForPart,
  instructionContainerHasAttribute,
  instructionForFixtureRefEdit,
  parseTimingColumnId,
  pruneEmptyAssertionInstructions,
  type TimingClearScope,
  timingClearTargetsForRowAttribute,
  timingColumnForGridColumn,
} from "../model/cue-editor-model";

interface CueEditorSelectionControllerOptions {
  context: CueEditorContextType;
  displayMode: Accessor<DisplayMode>;
  gridSelection: Accessor<GridSelection | undefined>;
  lastClickedCell: Accessor<Item | undefined>;
  flatRows: Accessor<CueFixtureRow[]>;
  columns: Accessor<CueGridColumn[]>;
  commitCueUpdate: (cue: types.Cue) => void;
  clearTimingOverridesForSelection: (
    selection: GridSelection | undefined,
    scope?: TimingClearScope,
  ) => boolean;
  timingDisplayUnit: (columnId: string | undefined) => RichTimeDisplayUnit;
  setTimingColumnDisplayUnitsForColumns: (
    columnIds: readonly string[],
    unit: RichTimeDisplayUnit,
  ) => void;
}

/** Owns cue grid selection targeting, delete commands, and context menus. */
export function createCueEditorSelectionController(
  options: CueEditorSelectionControllerOptions,
) {
  const ctx = options.context;
  const displayMode = options.displayMode;
  const gridSelection = options.gridSelection;
  const lastClickedCell = options.lastClickedCell;
  const flatRows = options.flatRows;
  const columns = options.columns;
  const commitCueUpdate = options.commitCueUpdate;
  const clearTimingOverridesForSelection =
    options.clearTimingOverridesForSelection;
  const timingDisplayUnit = options.timingDisplayUnit;
  const setTimingColumnDisplayUnitsForColumns =
    options.setTimingColumnDisplayUnitsForColumns;
  const $blueprints = useShallowStore(blueprintStore);

  const rangeContainsCell = (
    range: NonNullable<GridSelection["current"]>["range"],
    cell: Item,
  ): boolean => {
    const [columnIndex, rowIndex] = cell;
    return (
      columnIndex >= range.x &&
      columnIndex < range.x + range.width &&
      rowIndex >= range.y &&
      rowIndex < range.y + range.height
    );
  };

  /** Resolves column indexes affected by a cell context-menu operation. */
  const contextColumnIndicesForCell = (
    cell: Item,
    selection = gridSelection(),
  ): number[] => {
    const selectedColumns = selection?.columns.toArray() ?? [];
    if (selectedColumns.length > 0 && selectedColumns.includes(cell[0])) {
      return selectedColumns;
    }

    const rangeColumns = new Set<number>();
    if (selection?.current) {
      const ranges = [selection.current.range, ...selection.current.rangeStack];
      for (const range of ranges) {
        if (!rangeContainsCell(range, cell)) continue;
        for (
          let columnIndex = range.x;
          columnIndex < range.x + range.width;
          columnIndex++
        ) {
          rangeColumns.add(columnIndex);
        }
      }
    }

    return rangeColumns.size > 0
      ? [...rangeColumns].sort((left, right) => left - right)
      : [cell[0]];
  };

  /** Resolves row indexes affected by a cell context-menu operation. */
  const contextRowIndicesForCell = (
    cell: Item,
    selection = gridSelection(),
  ): number[] => {
    const selectedRows = selection ? getSelectedRowIndices(selection) : [];
    if (selectedRows.length > 0 && selectedRows.includes(cell[1])) {
      return selectedRows.filter(
        (rowIndex) => rowIndex >= 0 && rowIndex < flatRows().length,
      );
    }

    const rangeRows = new Set<number>();
    if (selection?.current) {
      const ranges = [selection.current.range, ...selection.current.rangeStack];
      for (const range of ranges) {
        if (!rangeContainsCell(range, cell)) continue;
        for (
          let rowIndex = range.y;
          rowIndex < range.y + range.height;
          rowIndex++
        ) {
          if (rowIndex >= 0 && rowIndex < flatRows().length) {
            rangeRows.add(rowIndex);
          }
        }
      }
    }

    return rangeRows.size > 0
      ? [...rangeRows].sort((left, right) => left - right)
      : [cell[1]];
  };

  /** Builds a grid selection for the context-menu target and any selected cells covering it. */
  const contextSelectionForCell = (
    cell: Item,
    selection = gridSelection(),
  ): GridSelection => {
    const selectedColumns = selection?.columns.toArray() ?? [];
    if (selection && selectedColumns.includes(cell[0])) {
      return selection;
    }

    const selectedRows = selection ? getSelectedRowIndices(selection) : [];
    if (selection && selectedRows.includes(cell[1])) {
      return selection;
    }

    if (selection?.current) {
      const ranges = [selection.current.range, ...selection.current.rangeStack];
      if (ranges.some((range) => rangeContainsCell(range, cell))) {
        return selection;
      }
    }

    return {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell,
        range: { x: cell[0], y: cell[1], width: 1, height: 1 },
        rangeStack: [],
      },
    };
  };

  /** Resolves selected attribute names for a column-header context-menu action. */
  const contextAttributeNamesForColumn = (columnIndex: number): string[] => {
    const selection = gridSelection();
    const selectedColumns = selection?.columns.toArray() ?? [];
    const columnIndexes =
      selectedColumns.length > 1 && selectedColumns.includes(columnIndex)
        ? selectedColumns
        : [columnIndex];
    const attrs = new Set<string>();
    for (const selectedColumnIndex of columnIndexes) {
      const attr = attributeForGridColumn(columns()[selectedColumnIndex]);
      if (attr) attrs.add(attr);
    }
    return [...attrs];
  };

  /** Resolves selected attribute names for a cell context-menu action. */
  const contextAttributeNamesForCell = (
    cell: Item,
    selection = gridSelection(),
  ): string[] => {
    const attrs = new Set<string>();
    for (const columnIndex of contextColumnIndicesForCell(cell, selection)) {
      const attr = attributeForGridColumn(columns()[columnIndex]);
      if (attr) attrs.add(attr);
    }
    return [...attrs];
  };

  /** Resolves value-cell attribute names affected by an assertion action. */
  const assertionAttributeNamesForCell = (
    cell: Item,
    selection = gridSelection(),
  ): string[] => {
    const attrs = new Set<string>();
    for (const columnIndex of contextColumnIndicesForCell(cell, selection)) {
      const column = columns()[columnIndex] as CueGridColumn | undefined;
      if (column?.cueColumnKind === "value" && column.cueAttribute) {
        attrs.add(column.cueAttribute);
      }
    }
    return [...attrs];
  };

  /** Resolves unique cue-instruction row targets for selected visible rows. */
  const instructionTargetsForRows = (
    rowIndices: readonly number[],
  ): { partIndex?: number; selectionIndex: number }[] => {
    const targets = new Map<
      string,
      { partIndex?: number; selectionIndex: number }
    >();
    for (const rowIndex of rowIndices) {
      const rowData = flatRows()[rowIndex];
      if (!rowData) continue;
      for (const target of rowData.instructionTargets) {
        if (target.selectionIndex < 0) continue;
        const key = `${target.partIndex ?? "parent"}:${target.selectionIndex}`;
        targets.set(key, {
          partIndex: target.partIndex,
          selectionIndex: target.selectionIndex,
        });
      }
    }
    return [...targets.values()];
  };

  /** Resolves exact fixture refs affected by selected visible rows. */
  const assertionTargetsForRows = (
    rowIndices: readonly number[],
  ): {
    partIndex?: number;
    selectionIndex: number;
    fixtureRef: types.FixtureRef;
  }[] => {
    const targets = new Map<
      string,
      {
        partIndex?: number;
        selectionIndex: number;
        fixtureRef: types.FixtureRef;
      }
    >();
    for (const rowIndex of rowIndices) {
      const rowData = flatRows()[rowIndex];
      if (!rowData) continue;
      for (const target of rowData.instructionTargets) {
        if (target.selectionIndex < 0) continue;
        const key = `${target.partIndex ?? "parent"}:${target.selectionIndex}:${fixtureRefKey(target.fixtureRef)}`;
        targets.set(key, {
          partIndex: target.partIndex,
          selectionIndex: target.selectionIndex,
          fixtureRef: target.fixtureRef,
        });
      }
    }
    return [...targets.values()];
  };

  /** Returns the instruction container for a cue-instruction row target. */
  const instructionContainerForTarget = (
    cue: types.Cue,
    target: { partIndex?: number },
  ): types.BoundCueInstruction[] | undefined => {
    return target.partIndex === undefined
      ? cue.instructions
      : cue.parts?.[target.partIndex]?.instructions;
  };

  /** Resolves the active cue part's array index used by instruction row targets. */
  const activePartIndex = (cue: types.Cue): number | undefined => {
    if (ctx.partId === 0) return undefined;
    const index = (cue.parts ?? []).findIndex(
      (part) => part.identifiers.id === ctx.partId,
    );
    return index >= 0 ? index : undefined;
  };

  /** Finds live Blueprint instructions intersecting the selected rows and attributes. */
  const referencedBlueprintTargets = (
    attrs: readonly string[],
    cell?: Item,
    selection?: GridSelection,
  ): ReferencedBlueprintInstructionTarget[] => {
    const cue = ctx.cue();
    if (!cue || attrs.length === 0) return [];
    const normalizedAttrs = new Set(attrs.map(normalizeAttributeName));
    const partIndex = activePartIndex(cue);
    const candidateTargets = cell
      ? instructionTargetsForRows(contextRowIndicesForCell(cell, selection))
      : (instructionContainerForPart(cue, ctx.partId) ?? []).map(
          (_instruction, selectionIndex) => ({ partIndex, selectionIndex }),
        );
    const targets = new Map<string, ReferencedBlueprintInstructionTarget>();
    const blueprints = $blueprints();

    for (const target of candidateTargets) {
      const instruction = instructionContainerForTarget(cue, target)?.[
        target.selectionIndex
      ]?.cue_instruction;
      const application = instruction?.blueprint_application;
      const blueprint = application
        ? blueprints[application.blueprint_uid]
        : undefined;
      if (!application || !blueprint) continue;
      const referencedAttrs = Object.keys(
        selectedBlueprintValues(blueprint, application.selector),
      ).map(normalizeAttributeName);
      if (!referencedAttrs.some((attr) => normalizedAttrs.has(attr))) continue;

      const key = `${target.partIndex ?? "parent"}:${target.selectionIndex}`;
      targets.set(key, {
        partIndex: target.partIndex,
        selectionIndex: target.selectionIndex,
        blueprintUid: application.blueprint_uid,
      });
    }
    return [...targets.values()];
  };

  /** Replaces selected live Blueprint instructions with their current direct values. */
  const makeBlueprintTargetsAbsolute = (
    targets: readonly ReferencedBlueprintInstructionTarget[],
  ): boolean => {
    const cue = ctx.cue();
    if (!cue || targets.length === 0) return false;
    const updatedCue: types.Cue = JSON.parse(JSON.stringify(cue));
    if (
      !makeBlueprintInstructionsAbsolute(updatedCue, targets, $blueprints())
    ) {
      return false;
    }
    commitCueUpdate(updatedCue);
    return true;
  };

  /** Removes attributes from every instruction in the currently edited cue part. */
  const deleteAttributesFromCurrentPart = (
    attrs: readonly string[],
  ): boolean => {
    const currentCue = ctx.cue();
    if (!currentCue || attrs.length === 0) return false;

    const updatedCue: types.Cue = JSON.parse(JSON.stringify(currentCue));
    const instructions = instructionContainerForPart(updatedCue, ctx.partId);
    if (!instructions) return false;

    let changed = false;
    for (const { cue_instruction: instruction } of instructions) {
      for (const attr of attrs) {
        changed = deleteInstructionAttribute(instruction, attr) || changed;
      }
    }
    if (!changed) return false;

    pruneEmptyAssertionInstructions(instructions);
    commitCueUpdate(updatedCue);
    return true;
  };

  /**
   * Removes selected fixture rows from the currently edited cue.
   * TODO: Split multi-fixture instructions so removing one resolved fixture row
   * does not remove other fixtures selected by the same instruction.
   */
  const removeFixturesFromCue = (cell: Item): boolean => {
    const currentCue = ctx.cue();
    if (!currentCue || ctx.isReleaseCue) return false;

    const targets = instructionTargetsForRows(contextRowIndicesForCell(cell));
    if (targets.length === 0) return false;

    const updatedCue: types.Cue = JSON.parse(JSON.stringify(currentCue));
    const targetsByPart = new Map<string, typeof targets>();
    for (const target of targets) {
      const key =
        target.partIndex === undefined ? "parent" : `${target.partIndex}`;
      const partTargets = targetsByPart.get(key) ?? [];
      partTargets.push(target);
      targetsByPart.set(key, partTargets);
    }

    let changed = false;
    for (const partTargets of targetsByPart.values()) {
      partTargets.sort(
        (left, right) => right.selectionIndex - left.selectionIndex,
      );
      const instructions = instructionContainerForTarget(
        updatedCue,
        partTargets[0],
      );
      if (!instructions) continue;
      for (const target of partTargets) {
        if (
          target.selectionIndex < 0 ||
          target.selectionIndex >= instructions.length
        ) {
          continue;
        }
        instructions.splice(target.selectionIndex, 1);
        changed = true;
      }
    }
    if (!changed) return false;

    commitCueUpdate(updatedCue);
    return true;
  };

  /** Marks an instruction attribute as release-only for cue editor value cells. */
  const markInstructionAttributeRelease = (
    instruction: types.CueInstruction,
    attr: string,
  ): boolean => {
    instruction.values ??= {};
    const matchingKeys = Object.keys(instruction.values).filter(
      (key) => key === attr || normalizeAttributeName(key) === attr,
    );
    const unchanged =
      matchingKeys.length === 1 &&
      matchingKeys[0] === attr &&
      instruction.values[attr]?.type === "Release";
    if (unchanged) return false;
    for (const key of matchingKeys) {
      delete instruction.values[key];
    }
    instruction.values[attr] = { type: "Release" };
    return true;
  };

  /** Clears or releases selected assertion value cells for selected fixture rows. */
  const clearAssertionAttributesForCell = (
    cell: Item,
    attrs: readonly string[],
    options: { release: boolean },
    selection = gridSelection(),
  ): boolean => {
    const currentCue = ctx.cue();
    if (!currentCue || ctx.isReleaseCue || attrs.length === 0) return false;

    const targets = assertionTargetsForRows(
      contextRowIndicesForCell(cell, selection),
    );
    if (targets.length === 0) return false;

    const updatedCue: types.Cue = JSON.parse(JSON.stringify(currentCue));
    let changed = false;
    const affectedContainers = new Set<types.BoundCueInstruction[]>();
    for (const target of targets) {
      const container = instructionContainerForTarget(updatedCue, target);
      const instructionItem = instructionForFixtureRefEdit(
        container,
        target.selectionIndex,
        target.fixtureRef,
        { create: options.release },
      );
      const instruction = instructionItem?.cue_instruction;
      if (!instruction) continue;
      for (const attr of attrs) {
        changed = options.release
          ? markInstructionAttributeRelease(instruction, attr) || changed
          : deleteInstructionAttributeValues(instruction, attr) || changed;
      }
      if (!options.release && container) {
        affectedContainers.add(container);
      }
    }
    if (!changed) return false;

    for (const container of affectedContainers) {
      pruneEmptyAssertionInstructions(container);
    }
    commitCueUpdate(updatedCue);
    return true;
  };

  /** Clears asserted value cells from the current grid selection. */
  const clearAssertionAttributesForSelection = (
    selection: GridSelection | undefined,
  ): boolean => {
    const cell = selection?.current?.cell ?? lastClickedCell();
    if (!cell) return false;
    return clearAssertionAttributesForCell(
      cell,
      assertionAttributeNamesForCell(cell, selection),
      { release: false },
      selection,
    );
  };

  /** Returns whether a timing clear operation has concrete selected targets. */
  const hasTimingOverrideClearTargets = (
    selection: GridSelection | undefined,
    scope: TimingClearScope = "parent",
  ): boolean => {
    const fallbackCell = lastClickedCell();
    if (displayMode() !== "timings" || (!selection && !fallbackCell)) {
      return false;
    }

    const currentRows = flatRows();
    const currentColumns = columns();
    /** Returns whether a grid coordinate can clear timing on any concrete row target. */
    const hasTimingCellTarget = (columnIndex: number, rowIndex: number) => {
      const rowData = currentRows[rowIndex];
      if (!rowData) return false;
      const timingColumn = timingColumnForGridColumn(
        currentColumns[columnIndex],
      );
      return (
        timingColumn !== undefined &&
        timingClearTargetsForRowAttribute(rowData, timingColumn.attr, scope)
          .length > 0
      );
    };

    if (selection) {
      for (const [columnIndex, rowIndex] of selectedClipboardCells(
        selection,
        currentRows.length,
        currentColumns.length,
      )) {
        if (hasTimingCellTarget(columnIndex, rowIndex)) return true;
      }
    }

    return fallbackCell
      ? hasTimingCellTarget(fallbackCell[0], fallbackCell[1])
      : false;
  };

  /** Clears whatever the current display mode treats as selected assertions. */
  const clearAssertionsForSelection = (
    selection: GridSelection | undefined,
    scope: TimingClearScope = "parent",
  ): boolean =>
    clearAssertionAttributesForSelection(selection) ||
    clearTimingOverridesForSelection(selection, scope);

  /** Returns whether the current display mode can clear selected assertions. */
  const canClearAssertionsForSelection = (
    selection: GridSelection | undefined,
  ): boolean => {
    if (displayMode() === "timings") {
      return hasTimingOverrideClearTargets(selection);
    }

    const cell = selection?.current?.cell;
    if (!cell || ctx.isReleaseCue) return false;
    return (
      assertionAttributeNamesForCell(cell, selection).length > 0 &&
      instructionTargetsForRows(contextRowIndicesForCell(cell, selection))
        .length > 0
    );
  };

  /** Opens the cue editor context menu for attribute and fixture operations. */
  const openCueEditorContextMenu = (options: {
    attrs: readonly string[];
    event: MouseEvent;
    columnId?: string;
    affectedColumnIds?: readonly string[];
    cell?: Item;
  }) => {
    const { attrs, event, columnId, affectedColumnIds = [], cell } = options;
    event.preventDefault();
    const currentCue = ctx.cue();
    const instructions = currentCue
      ? instructionContainerForPart(currentCue, ctx.partId)
      : undefined;
    const contextSelection = cell ? contextSelectionForCell(cell) : undefined;
    const assertionAttrs = cell
      ? assertionAttributeNamesForCell(cell, contextSelection)
      : [];
    const canClearAssertions =
      contextSelection !== undefined &&
      canClearAssertionsForSelection(contextSelection);
    const canDeleteAttributes =
      !ctx.isReleaseCue &&
      attrs.some((attr) =>
        instructionContainerHasAttribute(instructions, attr),
      );
    const canEditAssertions =
      !ctx.isReleaseCue &&
      cell !== undefined &&
      assertionAttrs.length > 0 &&
      instructionTargetsForRows(contextRowIndicesForCell(cell)).length > 0;
    const blueprintTargets =
      displayMode() === "values" && !ctx.isReleaseCue
        ? referencedBlueprintTargets(
            cell ? assertionAttrs : attrs,
            cell,
            contextSelection,
          )
        : [];
    const items: ContextMenuEntry[] = [
      ...(attrs.length > 0
        ? [
            {
              id: `delete-attributes-${attrs.join("-")}`,
              label:
                attrs.length > 1 ? "Delete attributes" : `Delete ${attrs[0]}`,
              icon: TrashIcon,
              danger: true,
              disabled: !canDeleteAttributes,
              onSelect: () => deleteAttributesFromCurrentPart(attrs),
            },
          ]
        : []),
      ...(blueprintTargets.length > 0
        ? [
            {
              type: "separator" as const,
              id: "blueprint-actions-separator",
            },
            {
              type: "submenu" as const,
              id: "blueprint-actions",
              label: "Blueprint",
              items: [
                {
                  id: "make-blueprint-absolute",
                  label: "Make Absolute (copy current values)",
                  onSelect: () =>
                    makeBlueprintTargetsAbsolute(blueprintTargets),
                },
              ],
            },
          ]
        : []),
      ...(cell
        ? [
            ...(attrs.length > 0
              ? [
                  {
                    type: "separator" as const,
                    id: "fixture-actions-separator",
                  },
                ]
              : []),
            {
              id: "remove-fixtures-from-cue",
              label: "Remove fixtures from cue",
              icon: TrashIcon,
              danger: true,
              disabled:
                ctx.isReleaseCue ||
                instructionTargetsForRows(contextRowIndicesForCell(cell))
                  .length === 0,
              onSelect: () => removeFixturesFromCue(cell),
            },
            {
              id: "clear-assertions",
              label: "Clear assertions",
              icon: EraserIcon,
              danger: true,
              disabled: !canClearAssertions,
              onSelect: () => clearAssertionsForSelection(contextSelection),
            },
            {
              id: "release-assertions",
              label: "Release assertions",
              icon: ArrowUUpLeftIcon,
              disabled: !canEditAssertions,
              onSelect: () =>
                clearAssertionAttributesForCell(cell, assertionAttrs, {
                  release: true,
                }),
            },
          ]
        : []),
      ...(typeof columnId === "string" && affectedColumnIds.length > 0
        ? [
            { type: "separator" as const, id: "units-separator" },
            ...timeUnitContextMenuEntries({
              currentUnit: timingDisplayUnit(columnId),
              onSelect: (unit) =>
                setTimingColumnDisplayUnitsForColumns(affectedColumnIds, unit),
            }),
          ]
        : []),
    ];

    if (items.length === 0) return;

    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items,
    });
  };

  /** Handles context menus opened from cue editor column headers. */
  const onColumnHeaderContextMenu = (
    colIndex: number,
    event: GroupHeaderClickedEventArgs,
  ) => {
    const attrs = contextAttributeNamesForColumn(colIndex);
    if (attrs.length === 0) return;
    openCueEditorContextMenu({ attrs, event });
  };

  /** Handles context menus opened from cue editor body cells. */
  const onCellContextMenu = (cell: Item, event: MouseEvent) => {
    const [col] = cell;
    const columnId = columns()[col]?.id;
    const columnIdString = typeof columnId === "string" ? columnId : undefined;
    openCueEditorContextMenu({
      attrs: contextAttributeNamesForCell(cell),
      event,
      columnId: columnIdString,
      affectedColumnIds: selectedTimeDisplayColumnIds({
        columns: columns(),
        clickedCell: cell,
        selection: gridSelection(),
        isTimeDisplayColumnId: (candidate) =>
          parseTimingColumnId(candidate ?? "") !== undefined,
      }),
      cell,
    });
  };

  /** Handles Delete and Backspace before the grid consumes them. */

  return {
    clearAssertionsForSelection,
    onCellContextMenu,
    onColumnHeaderContextMenu,
  };
}
