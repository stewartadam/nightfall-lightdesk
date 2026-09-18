// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  CustomCell,
  CustomRenderer,
  GridCell,
  GridColumn,
} from "../../../../lib/data-grid-types";
import { GridCellKind } from "../../../../lib/data-grid-types";
import { dataGridDarkTheme } from "../../../../lib/datagrid";
import {
  dropdownDisplayValue,
  isDropdownCell,
} from "../../../../lib/tanstack-dropdown-cell";
import {
  type KeyedDataGridCellProvider,
  keyedDataGridCellContent,
} from "./cell-provider";
import { cellDisplayValue, findCustomRenderer } from "./cell-utils";
import {
  columnId,
  columnWidth,
  type DataGridColumnDef,
  groupColumns,
} from "./column-model";
import { findRichCellExtension } from "./rich-cell-extension";
import type { DataGridRichCellExtension } from "./types";

const DEFAULT_MIN_COLUMN_WIDTH = 36;
const DEFAULT_MAX_COLUMN_WIDTH = 400;
const CELL_HORIZONTAL_PADDING = 16;
const CELL_CONTENT_GAP = 4;
const PREFIX_BADGE_WIDTH = 18;
const BOOLEAN_CONTROL_WIDTH = 18;
const DROPDOWN_HORIZONTAL_CHROME = 36;
const STATE_DOT_WIDTH = 8;
const STATE_TAG_HORIZONTAL_PADDING = 8;
const BODY_FONT = `${dataGridDarkTheme.baseFontStyle} ${dataGridDarkTheme.fontFamily}`;
const HEADER_FONT = `600 13px ${dataGridDarkTheme.fontFamily}`;
const STATE_TAG_FONT = `600 10px ${dataGridDarkTheme.fontFamily}`;

interface ContentColumnSizingOptions {
  columns: readonly GridColumn[];
  provider: KeyedDataGridCellProvider<any, any, any, any>;
  context: CanvasRenderingContext2D;
  customRenderers?: readonly CustomRenderer<any>[];
  richCellExtensions?: readonly DataGridRichCellExtension[];
  nestedColumnGroups: boolean;
}

interface TextMeasurementCache {
  widths: Map<string, number>;
}

/** Creates the canvas context used to measure grid content without mounting cells. */
export function createColumnMeasurementContext():
  | CanvasRenderingContext2D
  | undefined {
  if (typeof document === "undefined") return undefined;
  return document.createElement("canvas").getContext("2d") ?? undefined;
}

/** Clamps a measured content width to the column's declared bounds. */
function clampContentWidth(column: GridColumn, width: number): number {
  const minWidth = column.minWidth ?? DEFAULT_MIN_COLUMN_WIDTH;
  const maxWidth = Math.max(
    minWidth,
    column.maxWidth ?? DEFAULT_MAX_COLUMN_WIDTH,
  );
  return Math.ceil(Math.min(Math.max(width, minWidth), maxWidth));
}

/** Measures text with a font-aware cache shared by one complete sizing pass. */
function measureText(
  context: CanvasRenderingContext2D,
  cache: TextMeasurementCache,
  text: string,
  font: string,
): number {
  const key = `${font}\u0000${text}`;
  const cached = cache.widths.get(key);
  if (cached !== undefined) return cached;
  context.font = font;
  const width = context.measureText(text).width;
  cache.widths.set(key, width);
  return width;
}

/** Returns the compact rendered text for one state indicator tag. */
function stateIndicatorText(
  indicator: NonNullable<GridCell["stateIndicators"]>[number],
): string {
  if (indicator.text !== undefined) return indicator.text;
  switch (indicator.tone) {
    case "manual":
      return "M";
    case "transition":
      return "T";
    case "input":
      return "I";
    case "tracked":
      return "Tr";
    case "lookahead":
      return "Lookahead";
    case "conflict":
      return "Mix";
    case "error":
      return "!";
  }
}

/** Measures the prefix badge and state indicators rendered beside cell text. */
function measureCellAdornments(
  context: CanvasRenderingContext2D,
  cache: TextMeasurementCache,
  cell: GridCell,
): number {
  const widths: number[] = [];
  if (cell.prefixBadge || cell.prefixBadgeIcon) {
    widths.push(PREFIX_BADGE_WIDTH);
  }
  for (const indicator of cell.stateIndicators ?? []) {
    widths.push(
      indicator.variant === "tag"
        ? measureText(
            context,
            cache,
            stateIndicatorText(indicator),
            STATE_TAG_FONT,
          ) + STATE_TAG_HORIZONTAL_PADDING
        : STATE_DOT_WIDTH,
    );
  }
  if (widths.length === 0) return 0;
  return (
    widths.reduce((total, width) => total + width, 0) +
    widths.length * CELL_CONTENT_GAP
  );
}

/** Measures the intrinsic width of one resolved grid cell. */
function measureGridCellWidth(
  context: CanvasRenderingContext2D,
  cache: TextMeasurementCache,
  cell: GridCell,
  customRenderers?: readonly CustomRenderer<any>[],
  richCellExtensions?: readonly DataGridRichCellExtension[],
): number {
  const richCellExtension = findRichCellExtension(richCellExtensions, cell);
  if (richCellExtension?.measure) {
    return richCellExtension.measure({
      cell,
      editable: richCellExtension.isEditable(cell),
      measureText: (text) => measureText(context, cache, text, BODY_FONT),
    });
  }

  if (cell.kind === GridCellKind.Custom) {
    const renderer = findCustomRenderer(customRenderers, cell as CustomCell);
    if (renderer?.measure) {
      context.font = BODY_FONT;
      return renderer.measure(context, cell as never, {
        ...dataGridDarkTheme,
        ...(cell.themeOverride ?? {}),
      });
    }
  }

  const adornmentWidth = measureCellAdornments(context, cache, cell);
  if (cell.kind === GridCellKind.Boolean) {
    return CELL_HORIZONTAL_PADDING + BOOLEAN_CONTROL_WIDTH + adornmentWidth;
  }

  const text = isDropdownCell(cell)
    ? dropdownDisplayValue(cell)
    : cellDisplayValue(cell);
  const padding =
    isDropdownCell(cell) && cell.allowOverlay === true && !cell.readonly
      ? DROPDOWN_HORIZONTAL_CHROME
      : CELL_HORIZONTAL_PADDING;
  return (
    measureText(context, cache, text, BODY_FONT) + padding + adornmentWidth
  );
}

interface ColumnDefinitionSpan {
  label: unknown;
  firstLeafIndex: number;
  endLeafIndex: number;
}

/** Flattens the authoritative column-definition tree into measurable header spans. */
function columnDefinitionSpans(
  definitions: readonly DataGridColumnDef[],
  columns: readonly GridColumn[],
): ColumnDefinitionSpan[] {
  const columnIndexById = new Map(
    columns.map((column, index) => [columnId(column), index]),
  );

  /** Visits one definition and returns the half-open range of its leaf columns. */
  const visit = (
    definition: DataGridColumnDef,
  ): ColumnDefinitionSpan | undefined => {
    const children = "columns" in definition ? definition.columns : undefined;
    if (children && children.length > 0) {
      const childSpans = children
        .map((child) => visit(child))
        .filter((span): span is ColumnDefinitionSpan => span !== undefined);
      if (childSpans.length === 0) return undefined;
      const span = {
        label: definition.header,
        firstLeafIndex: childSpans[0]!.firstLeafIndex,
        endLeafIndex: childSpans[childSpans.length - 1]!.endLeafIndex,
      };
      spans.push(span);
      return span;
    }

    if (!definition.id) return undefined;
    const index = columnIndexById.get(definition.id);
    if (index === undefined) return undefined;
    const span = {
      label: definition.header,
      firstLeafIndex: index,
      endLeafIndex: index + 1,
    };
    spans.push(span);
    return span;
  };

  const spans: ColumnDefinitionSpan[] = [];
  for (const definition of definitions) visit(definition);
  return spans;
}

/** Expands content-sized leaf columns until every authoritative header label fits. */
function fitColumnDefinitionHeaders(
  columns: readonly GridColumn[],
  widths: number[],
  context: CanvasRenderingContext2D,
  cache: TextMeasurementCache,
  nestedColumnGroups: boolean,
): void {
  const definitions = groupColumns(columns, nestedColumnGroups);
  for (const header of columnDefinitionSpans(definitions, columns)) {
    if (typeof header.label !== "string") continue;
    const required =
      measureText(context, cache, header.label, HEADER_FONT) +
      CELL_HORIZONTAL_PADDING;
    const current = widths
      .slice(header.firstLeafIndex, header.endLeafIndex)
      .reduce((total, width) => total + width, 0);
    if (required <= current) continue;

    const adjustable: number[] = [];
    for (
      let index = header.firstLeafIndex;
      index < header.endLeafIndex;
      index += 1
    ) {
      if (columns[index]?.sizing !== "fixed") adjustable.push(index);
    }
    if (adjustable.length === 0) continue;

    let remaining = required - current;
    for (let offset = 0; offset < adjustable.length; offset += 1) {
      const index = adjustable[offset]!;
      const column = columns[index]!;
      const share = remaining / (adjustable.length - offset);
      const nextWidth = clampContentWidth(column, widths[index]! + share);
      remaining -= nextWidth - widths[index]!;
      widths[index] = nextWidth;
    }
  }
}

/** Resolves content-sized columns to stable numeric widths for virtualization. */
export function sizeColumnsToContent(
  options: ContentColumnSizingOptions,
): GridColumn[] {
  const cache: TextMeasurementCache = { widths: new Map() };
  const widths = options.columns.map((column) =>
    column.sizing === "fixed" ? columnWidth(column) : 0,
  );

  for (
    let columnIndex = 0;
    columnIndex < options.columns.length;
    columnIndex += 1
  ) {
    const column = options.columns[columnIndex]!;
    if (column.sizing === "fixed") continue;

    let widest = 0;
    for (
      let rowIndex = 0;
      rowIndex < options.provider.rows.length;
      rowIndex += 1
    ) {
      const cell = keyedDataGridCellContent(options.provider, [
        columnIndex,
        rowIndex,
      ]);
      if (!cell) continue;
      widest = Math.max(
        widest,
        measureGridCellWidth(
          options.context,
          cache,
          cell,
          options.customRenderers,
          options.richCellExtensions,
        ),
      );
    }
    widths[columnIndex] = clampContentWidth(
      column,
      widest > 0 ? widest : (column.width ?? DEFAULT_MIN_COLUMN_WIDTH),
    );
  }

  fitColumnDefinitionHeaders(
    options.columns,
    widths,
    options.context,
    cache,
    options.nestedColumnGroups,
  );
  return options.columns.map((column, index) => ({
    ...column,
    width: widths[index] ?? columnWidth(column),
  }));
}
