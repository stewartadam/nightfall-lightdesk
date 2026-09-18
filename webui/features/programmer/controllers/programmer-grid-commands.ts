// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { EraserIcon } from "@squidlab/phosphor-solid/eraser";
import { openContextMenu } from "../../../components/providers/context-menu";
import type { ContextMenuEntry } from "../../../components/widgets/context-menu/contract";
import {
  type HeaderCellView,
  selectedClipboardCells,
} from "../../../components/widgets/data-grid";
import { getAttributeMetadata } from "../../../lib/attribute-metadata";
import type {
  GridColumn,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { engineRuntime } from "../../../lib/engine-runtime";
import * as types from "../../../types";
import {
  type BlueprintApplicationScope,
  blueprintApplicationCommands,
} from "../model/blueprint-application";
import type { ProgrammerDisplayRow } from "../model/programmer-grid-model";

interface ProgrammerGridCommandOptions {
  columns: () => readonly GridColumn[];
  rows: () => readonly ProgrammerDisplayRow[];
  selection: () => GridSelection | undefined;
  blueprints: () => Record<string, types.Blueprint>;
}

/** Creates the programmer grid's selection-scoped clear and context-menu commands. */
export function createProgrammerGridCommands(
  options: ProgrammerGridCommandOptions,
) {
  /** Returns the programmer attribute represented by a grid column ID. */
  const attributeForColumnId = (columnId: string | undefined) => {
    const match = columnId?.match(/^(.+)_(Value|Abs|Rel)$/);
    return match?.[1];
  };

  /** Returns the programmer attribute represented by a visible grid column. */
  const attributeForColumnIndex = (columnIndex: number) =>
    attributeForColumnId(options.columns()[columnIndex]?.id);

  /** Converts a displayed attribute name into the command model attribute shape. */
  const commandAttributeForName = (attribute: string): types.Attribute =>
    getAttributeMetadata(attribute)?.attribute ?? {
      type: "Custom",
      data: { label: attribute },
    };

  /** Converts a displayed programmer row into a resolved fixture reference. */
  const fixtureRefForRow = (row: ProgrammerDisplayRow): types.FixtureRef => {
    if (row.type === "element") {
      return {
        fixture_uid: row.fixtureUid,
        index: row.elementIndex,
      };
    }

    return { fixture_uid: row.uid };
  };

  /** Builds a resolved selection expression for fixture refs, removing duplicates. */
  const selectionExprForFixtureRefs = (
    fixtureRefs: readonly types.FixtureRef[],
  ): types.SelectionExpr | undefined => {
    const seen = new Set<string>();
    const refs: types.FixtureRef[] = [];
    for (const ref of fixtureRefs) {
      const key = `${ref.fixture_uid}:${ref.index ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }

    return refs.length > 0 ? { type: "Resolved", data: refs } : undefined;
  };

  /** Wraps resolved fixture refs in the spatial selection expected by attribute operations. */
  const spatialSelectionForFixtureRefs = (
    fixtureRefs: readonly types.FixtureRef[],
  ): types.SpatialSelection | undefined => {
    const source = selectionExprForFixtureRefs(fixtureRefs);
    return source ? { source, clauses: [] } : undefined;
  };

  /** Applies one Blueprint independently to each fixture/attribute scope. */
  const applyBlueprint = (
    blueprint: types.Blueprint,
    scopes: readonly BlueprintApplicationScope[],
    resolution: types.BlueprintResolution,
  ) => {
    const commands = blueprintApplicationCommands(
      blueprint.identifiers.id,
      scopes,
      resolution,
    );
    for (const command of commands) {
      engineRuntime.sendCommand({ module: "ProgrammerCommand", command });
    }
  };

  /** Builds reference and absolute choices for every current Blueprint definition. */
  const blueprintApplicationMenu = (
    scopes: readonly BlueprintApplicationScope[],
  ): ContextMenuEntry => {
    const blueprints = Object.values(options.blueprints()).sort(
      (left, right) => left.identifiers.id - right.identifiers.id,
    );
    return {
      type: "submenu",
      id: "apply-blueprint",
      label: "Apply Blueprint",
      disabled:
        blueprints.length === 0 ||
        scopes.every((scope) => scope.targets.length === 0),
      items: blueprints.map((blueprint) => ({
        type: "submenu" as const,
        id: `apply-blueprint-${blueprint.identifiers.uid}`,
        label: `${blueprint.identifiers.id}: ${blueprint.identifiers.label}`,
        items: [
          {
            id: `apply-blueprint-reference-${blueprint.identifiers.uid}`,
            label: "Reference",
            onSelect: () =>
              applyBlueprint(
                blueprint,
                scopes,
                types.BlueprintResolution.Reference,
              ),
          },
          {
            id: `apply-blueprint-absolute-${blueprint.identifiers.uid}`,
            label: "Absolute (copy current values)",
            onSelect: () =>
              applyBlueprint(
                blueprint,
                scopes,
                types.BlueprintResolution.Absolute,
              ),
          },
        ],
      })),
    };
  };

  /** Sends a programmer release command for a selection and optional attributes. */
  const releaseProgrammerValues = (
    selection: types.SelectionExpr | undefined,
    attributes: readonly types.Attribute[],
  ) => {
    const command: types.ProgrammerCommand = {
      type: "ReleaseProgrammerValues",
      data: {
        ...(selection ? { selection } : {}),
        attributes: [...attributes],
      },
    };

    engineRuntime.sendCommand({
      module: "ProgrammerCommand",
      command,
    });
  };

  /** Returns every attribute column covered by a header cell. */
  const attributesForHeader = (header: HeaderCellView): string[] => {
    const attributes = new Set<string>();
    const currentColumns = options.columns();
    for (
      let index = header.firstLeafIndex;
      index < header.endLeafIndex;
      index += 1
    ) {
      const attribute = attributeForColumnId(currentColumns[index]?.id);
      if (attribute) attributes.add(attribute);
    }
    return [...attributes].sort();
  };

  /** Converts one attribute or category header into its future-looking selector. */
  const targetsForHeader = (
    header: HeaderCellView,
    attributes: readonly string[],
  ): types.BlueprintSelector[] => {
    const categoryName = header.id.startsWith("category:")
      ? header.id.slice("category:".length)
      : undefined;
    if (
      categoryName &&
      Object.values(types.AttributeCategory).includes(
        categoryName as types.AttributeCategory,
      )
    ) {
      return [
        {
          type: "Category",
          data: categoryName as types.AttributeCategory,
        },
      ];
    }
    return attributes.map((attribute) => ({
      type: "Attribute" as const,
      data: commandAttributeForName(attribute),
    }));
  };

  /** Formats a compact attribute or category context-menu label. */
  const clearAttributeLabel = (
    attributes: readonly string[],
    header?: HeaderCellView,
  ): string => {
    if (attributes.length === 1) return `Clear ${attributes[0]}`;
    const headerLabel =
      header && typeof header.label === "string" && header.label.length > 0
        ? header.label
        : `${attributes.length} attributes`;
    return `Clear ${headerLabel}`;
  };

  /** Opens the attribute/category context menu for programmer value release. */
  const openAttributeContextMenu = (
    attributes: readonly string[],
    x: number,
    y: number,
    header: HeaderCellView,
  ) => {
    if (attributes.length === 0) return;

    openContextMenu({
      x,
      y,
      items: [
        blueprintApplicationMenu([
          { targets: targetsForHeader(header, attributes) },
        ]),
        { id: "apply-blueprint-separator", type: "separator" },
        {
          id: `clear-attribute-${attributes.join("-")}`,
          label: clearAttributeLabel(attributes, header),
          icon: EraserIcon,
          danger: true,
          onSelect: () => {
            releaseProgrammerValues(
              undefined,
              attributes.map(commandAttributeForName),
            );
          },
        },
      ],
    });
  };

  /** Returns whether a cell belongs to the current grid selection. */
  const selectionContainsCell = (cell: Item): boolean => {
    const selection = options.selection();
    if (!selection) return false;
    return selectedClipboardCells(
      selection,
      options.rows().length,
      options.columns().length,
    ).some(([col, row]) => col === cell[0] && row === cell[1]);
  };

  /** Returns the body cells covered by a context-menu gesture. */
  const contextCellsForCell = (cell: Item): Item[] => {
    const selection = options.selection();
    if (selection && selectionContainsCell(cell)) {
      return selectedClipboardCells(
        selection,
        options.rows().length,
        options.columns().length,
      );
    }
    return [cell];
  };

  /** Collects fixture refs from selected cells, or the clicked row as a fallback. */
  const fixtureRefsForContextCell = (cell: Item): types.FixtureRef[] => {
    const rowIndices = new Set(contextCellsForCell(cell).map(([, row]) => row));
    const refs: types.FixtureRef[] = [];
    for (const rowIndex of rowIndices) {
      const row = options.rows()[rowIndex];
      if (row) refs.push(fixtureRefForRow(row));
    }
    return refs;
  };

  /** Returns the applicable attribute names covered by a context-menu gesture. */
  const attributesForContextCell = (cell: Item): string[] => {
    const attributes = new Set<string>();
    for (const [col, rowIndex] of contextCellsForCell(cell)) {
      const row = options.rows()[rowIndex];
      const attribute = attributeForColumnIndex(col);
      if (row && attribute && row.applicableAttributes.has(attribute)) {
        attributes.add(attribute);
      }
    }
    return [...attributes].sort();
  };

  /** Groups body cells by their per-row attribute set for scoped mutations. */
  const attributeScopesForCells = (
    cells: readonly Item[],
  ): { attributes: string[]; refs: types.FixtureRef[] }[] => {
    const attributesByRowKey = new Map<
      string,
      { ref: types.FixtureRef; attributes: Set<string> }
    >();

    for (const [col, rowIndex] of cells) {
      const row = options.rows()[rowIndex];
      if (!row) continue;
      const attribute = attributeForColumnIndex(col);
      if (!attribute || !row.applicableAttributes.has(attribute)) continue;

      const ref = fixtureRefForRow(row);
      const rowKey = `${ref.fixture_uid}:${ref.index ?? ""}`;
      const entry = attributesByRowKey.get(rowKey) ?? {
        ref,
        attributes: new Set<string>(),
      };
      entry.attributes.add(attribute);
      attributesByRowKey.set(rowKey, entry);
    }

    const refsByAttributeSet = new Map<
      string,
      { attributes: string[]; refs: types.FixtureRef[] }
    >();
    for (const { ref, attributes } of attributesByRowKey.values()) {
      const sortedAttributes = [...attributes].sort();
      const key = sortedAttributes.join("|");
      const entry = refsByAttributeSet.get(key) ?? {
        attributes: sortedAttributes,
        refs: [],
      };
      entry.refs.push(ref);
      refsByAttributeSet.set(key, entry);
    }

    return [...refsByAttributeSet.values()];
  };

  /** Clears all programmer values scoped to the provided row fixture refs. */
  const clearProgrammerRows = (
    fixtureRefs: readonly types.FixtureRef[],
  ): boolean => {
    const selection = selectionExprForFixtureRefs(fixtureRefs);
    if (!selection) return false;
    releaseProgrammerValues(selection, []);
    return true;
  };

  /** Releases programmer attribute values represented by explicit body cells. */
  const clearAttributeValuesForCells = (cells: readonly Item[]): boolean => {
    const scopes = attributeScopesForCells(cells);
    if (scopes.length === 0) return false;

    for (const { attributes, refs } of scopes) {
      const scopedSelection = selectionExprForFixtureRefs(refs);
      if (scopedSelection) {
        releaseProgrammerValues(
          scopedSelection,
          attributes.map(commandAttributeForName),
        );
      }
    }

    return true;
  };

  /** Opens the selected-row context menu from a programmer body cell. */
  const onCellContextMenu = (cell: Item, event: MouseEvent) => {
    event.preventDefault();
    const contextCells = contextCellsForCell(cell);
    const fixtureRefs = fixtureRefsForContextCell(cell);
    const attributes = attributesForContextCell(cell);
    const blueprintScopes = attributeScopesForCells(contextCells).flatMap(
      ({ attributes: scopedAttributes, refs }) => {
        const selection = spatialSelectionForFixtureRefs(refs);
        return selection
          ? [
              {
                selection,
                targets: scopedAttributes.map((attribute) => ({
                  type: "Attribute" as const,
                  data: commandAttributeForName(attribute),
                })),
              },
            ]
          : [];
      },
    );
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        ...(blueprintScopes.length > 0
          ? [
              blueprintApplicationMenu(blueprintScopes),
              {
                type: "separator" as const,
                id: "apply-cell-blueprint-separator",
              },
            ]
          : []),
        ...(attributes.length > 0
          ? [
              {
                id: `clear-cell-attributes-${attributes.join("-")}`,
                label:
                  contextCells.length === 1
                    ? clearAttributeLabel(attributes)
                    : "Clear selected values",
                icon: EraserIcon,
                danger: true,
                onSelect: () => clearAttributeValuesForCells(contextCells),
              },
              { type: "separator" as const, id: "clear-row-separator" },
            ]
          : []),
        {
          id: "clear-programmer-rows",
          label:
            fixtureRefs.length === 1
              ? "Clear row"
              : `Clear ${fixtureRefs.length} rows`,
          icon: EraserIcon,
          danger: true,
          disabled: fixtureRefs.length === 0,
          onSelect: () => clearProgrammerRows(fixtureRefs),
        },
      ],
    });
  };

  /** Opens the programmer attribute/category context menu from a header cell. */
  const onColumnHeaderContextMenu = (
    colIndex: number,
    event: MouseEvent,
    header: HeaderCellView,
  ) => {
    event.preventDefault();
    const headerAttributes = attributesForHeader(header);
    const fallbackAttribute = attributeForColumnIndex(colIndex);
    const attributes =
      headerAttributes.length > 0
        ? headerAttributes
        : fallbackAttribute
          ? [fallbackAttribute]
          : [];
    openAttributeContextMenu(attributes, event.clientX, event.clientY, header);
  };

  /** Handles Delete/Backspace from the grid without invoking default cell edits. */
  const onDelete = (selection: GridSelection): boolean =>
    clearAttributeValuesForCells(
      selectedClipboardCells(
        selection,
        options.rows().length,
        options.columns().length,
      ),
    );

  return { onCellContextMenu, onColumnHeaderContextMenu, onDelete };
}
