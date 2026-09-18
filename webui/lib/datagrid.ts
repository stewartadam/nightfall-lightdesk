// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Accessor, Setter } from "solid-js";
import type * as types from "../types";
import { sortedAttributes } from "./attribute-ordering";
import { DATA_GRID_NOT_APPLICABLE_BG } from "./constants";
import {
  CompactSelection,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
} from "./data-grid-types";
import { attributeColumnVisibilityMeta } from "./datagrid-column-visibility";
import {
  type FixtureValueSourceState,
  fixtureValueSourceState,
} from "./fixture-value-state";
import { normalizeAttributeName } from "./utils";

export const dataGridDarkTheme = {
  accentColor: "#8c96ff",
  accentLight: "rgba(202, 206, 255, 0.253)",

  textDark: "#ffffff",
  textMedium: "#b8b8b8",
  textLight: "#a0a0a0",
  textBubble: "#ffffff",

  bgIconHeader: "#b8b8b8",
  fgIconHeader: "#000000",
  textHeader: "#a1a1a1",
  textHeaderSelected: "#000000",
  textGroupHeader: "#a1a1a1",

  bgCell: "#16161b",
  bgCellMedium: "#202027",
  bgHeader: "#212121",
  bgHeaderHasFocus: "#474747",
  bgHeaderHovered: "#404040",

  bgBubble: "#212121",
  bgBubbleSelected: "#000000",

  bgSearchResult: "#423c24",

  borderColor: "rgba(225,225,225,0.2)",
  drilldownBorder: "rgba(225,225,225,0.4)",

  linkColor: "#4F5DFF",

  headerFontStyle: "bold 14px",
  baseFontStyle: "13px",
  fontFamily:
    "Inter, Roboto, -apple-system, BlinkMacSystemFont, avenir next, avenir, segoe ui, helvetica neue, helvetica, Ubuntu, noto, arial, sans-serif",
  cellHorizontalPadding: 8,
  checkboxMaxSize: 18,
};

export const FIXTURE_VALUE_TEXT_COLORS = {
  aggregate: "#FFFFFF",
  blueprint: "#6EE7B7",
  input: "#9CA3AF",
  manual: "#B71C1C",
  normal: "#FFFFFF",
  tracked: "#9C27B0",
  transition: "#FFD166",
} as const;

export const CONFLICT_VALUE_TEXT_COLOR = "#ef4444";

const FIXTURE_VALUE_BACKGROUND_COLORS = {
  attribute: "#1a1a1f",
  invalid: "#FF6F00",
  lookaheadCompleted: "#00332b",
  lookaheadTransitioning: "#007360",
  notApplicable: DATA_GRID_NOT_APPLICABLE_BG,
  transitioning: "#594a00",
} as const;

const DEFAULT_ATTRIBUTE_VALUE_COLUMN_WIDTH = 88;

export interface AttributeValueColumnWidthOptions {
  hasPrefixBadge?: boolean;
  stateIndicatorCount?: number;
}

export interface FixtureAttributeValueStylingOptions {
  sourceLayers?: readonly types.OutboundLayerState[];
  sourceState?: FixtureValueSourceState;
  fixtureUid?: string;
  elementIndex?: number;
  attribute?: string;
  layerFilter?: (layer: types.OutboundLayerState) => boolean;
  isTransitioning?: boolean;
  isElement?: boolean;
  sourceStateEnabled?: boolean;
}

/** Resolves a stable value-column width for marker-prefixed percentage text. */
export function attributeValueColumnWidth(
  _options: AttributeValueColumnWidthOptions = {},
): number {
  return DEFAULT_ATTRIBUTE_VALUE_COLUMN_WIDTH;
}

/** Prefixes a value display string with the compact BRD marker text. */
function markerDisplay(marker: string, value: string): string {
  return value.length > 0 ? `${marker} ${value}` : marker;
}

/** Adds a compact BRD marker directly to a text cell's display value. */
function withFixtureValueMarker(cell: GridCell, marker: string): GridCell {
  if (cell.kind !== GridCellKind.Text) return cell;
  const display = cell.displayData ?? cell.data;
  if (display.startsWith(`${marker} `) || display === marker) return cell;
  return {
    ...cell,
    displayData: markerDisplay(marker, display),
  };
}

/** Applies a BRD fixture value state background to a grid cell. */
function withFixtureValueBackground(
  cell: GridCell,
  backgroundColor: string,
): GridCell {
  return {
    ...cell,
    themeOverride: {
      ...cell.themeOverride,
      bgCell: backgroundColor,
      bgCellMedium: backgroundColor,
    },
  };
}

/** Parses a six-digit hex color into normalized RGB channels. */
function parseHexColor(color: string): { r: number; g: number; b: number } {
  const match = color.match(/^#([0-9a-fA-F]{6})$/);
  if (!match) {
    return { r: 1, g: 1, b: 1 };
  }

  const numeric = Number.parseInt(match[1], 16);
  return {
    r: ((numeric >> 16) & 0xff) / 255,
    g: ((numeric >> 8) & 0xff) / 255,
    b: (numeric & 0xff) / 255,
  };
}

/** Converts normalized RGB channels to HSV. */
function rgbToHsv({ r, g, b }: { r: number; g: number; b: number }): {
  h: number;
  s: number;
  v: number;
} {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;

  if (delta !== 0) {
    if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h /= 6;
    if (h < 0) h += 1;
  }

  return {
    h,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

/** Converts HSV channels to normalized RGB. */
function hsvToRgb({ h, s, v }: { h: number; s: number; v: number }): {
  r: number;
  g: number;
  b: number;
} {
  const sector = h * 6;
  const index = Math.floor(sector);
  const fraction = sector - index;
  const p = v * (1 - s);
  const q = v * (1 - fraction * s);
  const t = v * (1 - (1 - fraction) * s);

  switch (index % 6) {
    case 0:
      return { r: v, g: t, b: p };
    case 1:
      return { r: q, g: v, b: p };
    case 2:
      return { r: p, g: v, b: t };
    case 3:
      return { r: p, g: q, b: v };
    case 4:
      return { r: t, g: p, b: v };
    default:
      return { r: v, g: p, b: q };
  }
}

/** Formats normalized RGB channels as a six-digit uppercase hex color. */
function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const channel = (value: number) =>
    Math.round(Math.min(Math.max(value, 0), 1) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Returns the BRD transition tint derived from the otherwise-winning color. */
export function fixtureValueTransitionColor(color: string): string {
  const hsv = rgbToHsv(parseHexColor(color));
  return rgbToHex(
    hsvToRgb({
      h: hsv.h,
      s: hsv.s * 0.6,
      v: hsv.v + (1 - hsv.v) * 0.25,
    }),
  );
}

export function makeSafeTextCell(value: unknown): GridCell {
  let display = "";

  if (typeof value === "string") {
    display = value;
  } else if (value === null || value === undefined) {
    display = "";
  } else if (typeof value === "object") {
    display = JSON.stringify(value);
  } else {
    display = String(value);
  }

  return {
    kind: GridCellKind.Text,
    data: display,
    displayData: display,
    allowOverlay: false,
  } as const;
}

const NOT_APPLICABLE_CELL: GridCell = {
  kind: GridCellKind.Text,
  data: "",
  displayData: "",
  allowOverlay: false,
  themeOverride: {
    bgCell: DATA_GRID_NOT_APPLICABLE_BG,
    bgCellMedium: DATA_GRID_NOT_APPLICABLE_BG,
  },
} as const;

export function makeNotApplicableCell(): GridCell {
  return NOT_APPLICABLE_CELL;
}

/// Formats a data grid value as either a raw value or percentage, with up to
/// a single decimal point of precision.
const formatDataGridNumber = (
  num: number | string | undefined,
  is_percentage: boolean,
): string => {
  if (num === undefined) return "";
  let value = typeof num === "string" ? Number.parseFloat(num) : num;
  if (is_percentage) value *= 100;

  const precision = value % 1 === 0 ? 0 : 1;
  const str_value = value.toFixed(precision);

  return is_percentage ? `${str_value}%` : str_value;
};

// === NEW SHARED DATAGRID UTILITIES ===

/**
 * Represents processed parameter values with absolute/relative metadata
 */
export interface ProcessedParameterValue {
  value?: number;
  isPercentage: boolean;
  isRelative: boolean;
  marker?: "release" | "block" | "hold";
  blueprintSource?: types.OutboundBlueprintValueSource;
}

/**
 * Data structure for attribute values with absolute/relative separation
 */
export interface AttributeValues {
  absolute: Record<string, ProcessedParameterValue>;
  relative: Record<string, ProcessedParameterValue>;
}

/** Enables category and attribute nested headers for attribute value grids. */
export const ATTRIBUTE_VALUE_NESTED_COLUMN_GROUPS = true;

/**
 * Creates the canonical grid cell for an attribute value.
 */
export function createAttributeValueCell(
  value: ProcessedParameterValue | undefined,
  options: {
    allowOverlay?: boolean;
    themeOverride?: GridCell["themeOverride"];
  } = {},
): GridCell {
  if (!value) {
    return {
      ...makeSafeTextCell(""),
      allowOverlay: options.allowOverlay ?? false,
      themeOverride: options.themeOverride,
    };
  }

  const markerLabel =
    value.marker === "release"
      ? "R"
      : value.marker === "block"
        ? "B"
        : value.marker === "hold"
          ? "H"
          : undefined;
  const displayValue =
    value.value === undefined
      ? undefined
      : formatDataGridNumber(value.value, value.isPercentage);
  const markedDisplayValue =
    value.isRelative && displayValue
      ? markerDisplay("~", displayValue)
      : displayValue;
  const separatesMarkerBadge =
    value.marker === "block" && value.isRelative && markedDisplayValue;
  const authoredDisplayData = markerLabel
    ? separatesMarkerBadge
      ? markedDisplayValue
      : markedDisplayValue
        ? markerDisplay(markerLabel, markedDisplayValue)
        : markerLabel
    : (markedDisplayValue ?? "");
  const blueprintLabel = value.blueprintSource
    ? `BP ${value.blueprintSource.blueprint_id} ${value.blueprintSource.blueprint_label}`
    : undefined;
  const displayData = blueprintLabel
    ? `${authoredDisplayData} · ${blueprintLabel}`
    : authoredDisplayData;

  return {
    kind: GridCellKind.Text,
    data:
      value.value !== undefined ? value.value.toString() : (markerLabel ?? ""),
    displayData,
    copyData: blueprintLabel
      ? displayData
      : value.marker
        ? markerLabel
          ? markerDisplay(markerLabel, markedDisplayValue ?? "")
          : displayData
        : value.isRelative
          ? displayValue
          : undefined,
    prefixBadge: separatesMarkerBadge ? markerLabel : undefined,
    prefixBadgeLabel: separatesMarkerBadge ? "Blocked" : undefined,
    allowOverlay: options.allowOverlay ?? true,
    themeOverride: {
      bgCell: FIXTURE_VALUE_BACKGROUND_COLORS.attribute,
      bgCellMedium: FIXTURE_VALUE_BACKGROUND_COLORS.attribute,
      ...(blueprintLabel
        ? { textDark: FIXTURE_VALUE_TEXT_COLORS.blueprint }
        : {}),
      ...options.themeOverride,
    },
  };
}

/** Returns true when a cell has visible or copyable value content. */
export function cellHasDisplayValue(cell: GridCell): boolean {
  if (cell.kind === GridCellKind.Text) {
    return (cell.displayData ?? cell.data ?? "").length > 0;
  }
  if (cell.kind === GridCellKind.Number) {
    return cell.displayData !== undefined || cell.data !== undefined;
  }
  if (cell.kind === GridCellKind.Custom) {
    return typeof cell.copyData === "string" && cell.copyData.length > 0;
  }
  return false;
}

/** Applies manual assertion treatment to a fixture value cell. */
function applyManualAssertionStyling(
  cell: GridCell,
  options: { winning?: boolean; shadowed?: boolean } = {},
): GridCell {
  if (!cellHasDisplayValue(cell)) return cell;
  if (options.winning) {
    if (cell.themeOverride?.textDark !== undefined) return cell;
    return {
      ...cell,
      themeOverride: {
        ...cell.themeOverride,
        textDark: FIXTURE_VALUE_TEXT_COLORS.manual,
      },
    };
  }
  if (options.shadowed) {
    return cell;
  }
  return cell;
}

/** Applies invalid source metadata treatment to a fixture value cell. */
export function applyInvalidSourceStyling(cell: GridCell): GridCell {
  if (!cellHasDisplayValue(cell)) return cell;
  return withFixtureValueMarker(
    withFixtureValueBackground(cell, FIXTURE_VALUE_BACKGROUND_COLORS.invalid),
    "!",
  );
}

/** Applies input assertion treatment to a fixture value cell. */
function applyInputAssertionStyling(cell: GridCell): GridCell {
  if (!cellHasDisplayValue(cell)) return cell;
  return {
    ...cell,
    themeOverride: {
      ...cell.themeOverride,
      textDark: FIXTURE_VALUE_TEXT_COLORS.input,
    },
  };
}

/** Applies tracked-value treatment to a fixture value cell. */
export function applyTrackedValueStyling(cell: GridCell): GridCell {
  if (!cellHasDisplayValue(cell)) return cell;
  return {
    ...cell,
    themeOverride: {
      ...cell.themeOverride,
      textDark: FIXTURE_VALUE_TEXT_COLORS.tracked,
    },
  };
}

/** Applies lookahead treatment to a fixture value cell. */
export function applyLookaheadStyling(cell: GridCell): GridCell {
  if (!cellHasDisplayValue(cell)) return cell;
  return withFixtureValueBackground(
    cell,
    FIXTURE_VALUE_BACKGROUND_COLORS.lookaheadCompleted,
  );
}

/** Applies the resolved fixture value source state to a cell. */
export function applyFixtureValueSourceStyling(
  cell: GridCell,
  state:
    | {
        winningSource: "manual" | "input" | "normal" | null;
        hasShadowedManual: boolean;
      }
    | undefined,
): GridCell {
  if (!state) return cell;
  let next = cell;
  if (state.winningSource === "manual") {
    next = applyManualAssertionStyling(next, { winning: true });
  } else if (state.winningSource === "input") {
    next = applyInputAssertionStyling(next);
  }
  if (state.hasShadowedManual && state.winningSource !== "manual") {
    next = applyManualAssertionStyling(next, { shadowed: true });
  }
  return next;
}

/** Resolves source state for a fixture attribute cell when row context is available. */
function resolvedFixtureAttributeValueSourceState(
  cell: GridCell,
  options: FixtureAttributeValueStylingOptions,
): FixtureValueSourceState | undefined {
  if (options.sourceState !== undefined) return options.sourceState;
  if (options.sourceStateEnabled === false) return undefined;
  if (!cellHasDisplayValue(cell)) return undefined;
  if (
    options.sourceLayers === undefined ||
    options.fixtureUid === undefined ||
    options.attribute === undefined
  ) {
    return undefined;
  }

  return fixtureValueSourceState(
    options.sourceLayers,
    options.fixtureUid,
    options.elementIndex,
    options.attribute,
    options.layerFilter,
  );
}

/** Applies source, transition, and element treatment for a fixture attribute value cell. */
export function applyFixtureAttributeValueStyling(
  cell: GridCell,
  options: FixtureAttributeValueStylingOptions = {},
): GridCell {
  const sourceState = resolvedFixtureAttributeValueSourceState(cell, options);
  const cellWithSource = applyFixtureValueSourceStyling(cell, sourceState);
  const cellWithTransition = applyTransitionStyling(
    cellWithSource,
    options.isTransitioning ?? false,
  );
  const cellWithTransitionText =
    options.isTransitioning === true && sourceState?.winningSource === "normal"
      ? {
          ...cellWithTransition,
          themeOverride: {
            ...cellWithTransition.themeOverride,
            textDark: FIXTURE_VALUE_TEXT_COLORS.transition,
          },
        }
      : cellWithTransition;
  return applyElementBackground(
    cellWithTransitionText,
    options.isElement ?? false,
  );
}

/** Applies the parent aggregate varied presentation to a fixture value cell. */
export function applyAggregateConflictStyling(
  cell: GridCell,
  isConflicted: boolean,
  conflictColor: string = FIXTURE_VALUE_TEXT_COLORS.aggregate,
  options: { preserveValue?: boolean } = {},
): GridCell {
  if (!isConflicted) return cell;

  if (cell.kind !== GridCellKind.Text) {
    return cell;
  }

  const displayData = options.preserveValue
    ? (cell.displayData ?? cell.data)
    : "";
  return {
    ...cell,
    data: options.preserveValue ? cell.data : "",
    displayData,
    copyData: displayData ? `[V] ${displayData}` : "[V]",
    prefixBadge: "V",
    prefixBadgeLabel: "Varied element values",
    themeOverride: {
      ...cell.themeOverride,
      textDark: conflictColor,
    },
  };
}

/**
 * Creates column definitions for attribute value display mode.
 */
export function createAttrValueColumns(
  attributes: string[],
  baseColumns: GridColumn[],
  options: {
    valueTitle?: string;
    valueWidth?: number;
    valueWidths?: Record<string, number>;
    outputTitle?: string;
    outputWidth?: number;
    outputIdSuffix?: string;
    outputVisibilityLabel?: string;
  } = {},
): GridColumn[] {
  const columns = [...baseColumns];
  const valueTitle = options.valueTitle ?? "";
  const outputIdSuffix = options.outputIdSuffix ?? "Out";
  const outputVisibilityLabel = options.outputVisibilityLabel ?? "DMX";

  for (const attr of sortedAttributes(attributes)) {
    const displayName = normalizeAttributeName(attr);
    const valueWidth =
      options.valueWidths?.[displayName] ??
      options.valueWidths?.[attr] ??
      options.valueWidth ??
      DEFAULT_ATTRIBUTE_VALUE_COLUMN_WIDTH;
    columns.push({
      title: valueTitle,
      id: `${attr}_Value`,
      width: valueWidth,
      sizing: "fixed",
      group: displayName,
      ...attributeColumnVisibilityMeta(attr, "Value"),
    });
    if (options.outputTitle !== undefined) {
      columns.push({
        title: options.outputTitle,
        id: `${attr}_${outputIdSuffix}`,
        width: options.outputWidth ?? 54,
        sizing: "fixed",
        group: displayName,
        ...attributeColumnVisibilityMeta(attr, outputVisibilityLabel),
      });
    }
  }

  return columns;
}

/**
 * Creates a cell for displaying one asserted fixture attribute value and output value.
 */
export function createAttributeARCell(
  attr: string,
  attributeValues: AttributeValues,
  outputValues?: Record<string, number>,
  showOutput = false,
): GridCell {
  if (showOutput && outputValues) {
    const val = outputValues[attr];
    if (val !== undefined) {
      return createAttributeValueCell(
        { value: val, isPercentage: false, isRelative: false },
        { allowOverlay: false },
      );
    }
  }

  const val = attributeValues.relative[attr] ?? attributeValues.absolute[attr];
  if (val) {
    return createAttributeValueCell(val);
  }

  return makeSafeTextCell("");
}

/**
 * Creates a cell for displaying asserted values and output values from a grid column id.
 */
export function createARCell(
  colId: string,
  attributeValues: AttributeValues,
  outputValues?: Record<string, number>,
  showOutput = false,
): GridCell {
  const match = colId.match(/^(.+)_Value$/);
  if (!match) {
    return makeSafeTextCell("");
  }

  return createAttributeARCell(
    match[1],
    attributeValues,
    outputValues,
    showOutput,
  );
}

/**
 * Type for a fixture row with asserted value data
 */
export interface ARFixtureRow {
  uid: string;
  id: number;
  name: string;
  color: string;
  attributes: AttributeValues;
  applicableAttributes: Set<string>;
}

// === ELEMENT EXPANSION UTILITIES ===

/**
 * Extension for rows that support element expansion (parent rows)
 */
export interface ExpandableRowExtension {
  type: "parent";
  hasElements: boolean;
  isExpanded: boolean;
  conflicts?: Set<string>;
}

/**
 * Extension for element rows (child rows)
 */
export interface ElementRowExtension {
  type: "element";
  fixtureUid: string;
  elementIndex: number;
}

/**
 * Formats the ID column text with proper chevrons and alignment
 *
 * @param id - The fixture ID number
 * @param rowType - Whether this is a parent or element row
 * @param hasElements - Whether the parent row has expandable elements
 * @param isExpanded - Whether the parent row is currently expanded
 * @param elementIndex - The element index (for element rows)
 * @param indentSpaces - Number of spaces to use for indentation (default: 4)
 * @returns Formatted display text for the ID column
 */
export function formatIdWithChevron(
  id: number,
  rowType: "parent" | "element",
  hasElements: boolean,
  isExpanded: boolean,
  elementIndex?: number,
  indentSpaces = 4,
): string {
  const indent = "\u00a0".repeat(indentSpaces);

  if (rowType === "element" && elementIndex !== undefined) {
    // Element row: indent + "ID.Element"
    return `${indent}${id}.${elementIndex}`;
  }

  if (rowType === "parent" && hasElements) {
    // Parent row with elements: chevron + ID
    return `${isExpanded ? "▼" : "▶"} ${id}`;
  }

  // Parent row without elements: indent for alignment
  return `${indent}${id}`;
}

/**
 * Applies the element background color to a cell's theme override
 *
 * @param cell - The GridCell to modify
 * @param isElement - Whether this is an element row
 * @param elementBgColor - Background color for element rows (default: "#1a1a1f")
 * @returns Modified GridCell with background applied if isElement is true
 */
export function applyElementBackground(
  cell: GridCell,
  isElement: boolean,
  elementBgColor: string = FIXTURE_VALUE_BACKGROUND_COLORS.attribute,
): GridCell {
  if (!isElement) return cell;

  return {
    ...cell,
    themeOverride: {
      ...cell.themeOverride,
      bgCell: cell.themeOverride?.bgCell ?? elementBgColor,
      bgCellMedium: cell.themeOverride?.bgCellMedium ?? elementBgColor,
    },
  };
}

/**
 * Applies transition state background to cells whose displayed value is active.
 */
export function applyTransitionStyling(
  cell: GridCell,
  isTransitioning: boolean,
): GridCell {
  if (!isTransitioning) return cell;

  const currentBackground = String(cell.themeOverride?.bgCell ?? "");
  if (
    currentBackground === FIXTURE_VALUE_BACKGROUND_COLORS.invalid ||
    currentBackground === FIXTURE_VALUE_BACKGROUND_COLORS.notApplicable
  ) {
    return cell;
  }

  return withFixtureValueBackground(
    cell,
    currentBackground === FIXTURE_VALUE_BACKGROUND_COLORS.lookaheadCompleted
      ? FIXTURE_VALUE_BACKGROUND_COLORS.lookaheadTransitioning
      : FIXTURE_VALUE_BACKGROUND_COLORS.transitioning,
  );
}

/**
 * Sorts display rows by ID, ensuring parent rows come before their children
 *
 * @param rows - Array of rows to sort
 * @returns Sorted array
 */
export function sortRowsByIdAndType<
  T extends { id: number; type: "parent" | "element"; elementIndex?: number },
>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    if (a.id !== b.id) return a.id - b.id;
    if (a.type === "parent" && b.type === "element") return -1;
    if (a.type === "element" && b.type === "parent") return 1;
    if (
      a.type === "element" &&
      b.type === "element" &&
      a.elementIndex !== undefined &&
      b.elementIndex !== undefined
    ) {
      return a.elementIndex - b.elementIndex;
    }
    return 0;
  });
}

// === ROW SELECTION UTILITIES ===

/**
 * Creates an empty grid selection state
 */
export function emptyGridSelection(): GridSelection {
  return {
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  };
}

/**
 * Extracts selected row indices from a GridSelection as an array
 */
export function getSelectedRowIndices(selection: GridSelection): number[] {
  const indices: number[] = [];
  for (const idx of selection.rows) {
    indices.push(idx);
  }
  return indices;
}

/**
 * Hook-like helper for row selection state management.
 * Returns props to spread on DataGrid and helper functions.
 *
 * @param selection - Accessor for the current GridSelection state
 * @param setSelection - Setter for the GridSelection state
 * @returns Object with gridProps and helper functions
 */
export function createRowSelectionHelpers(
  selection: Accessor<GridSelection>,
  setSelection: Setter<GridSelection>,
) {
  const selectedRows = (): number[] => getSelectedRowIndices(selection());

  const clearSelection = () => {
    setSelection(emptyGridSelection());
  };

  const handleGridSelectionChange = (newSelection: GridSelection) => {
    setSelection(newSelection);
  };

  // Props to spread on DataGrid for row selection
  const gridSelectionProps = {
    rowMarkers: "checkbox" as const,
  };

  return {
    /** Array of currently selected row indices */
    selectedRows,
    /** Clear all selected rows */
    clearSelection,
    /** Handler for onGridSelectionChange prop */
    handleGridSelectionChange,
    /** Static props to spread on DataGrid */
    gridSelectionProps,
  };
}

/**
 * Determines which rows to edit based on cell range selection.
 * If a rectangular cell selection is active and the edited cell is in that selection,
 * returns all rows in the selection. Otherwise returns just the edited row.
 *
 * @param gridSelection - The current grid selection state
 * @param editedCol - The column index of the cell being edited
 * @param editedRow - The row index of the cell being edited
 * @param maxRows - Maximum number of rows available in the data
 * @returns Array of row indices to edit (usually 1, but multiple if range is selected)
 */
export function getRowsToEdit(
  gridSelection: GridSelection | undefined,
  editedCol: number,
  editedRow: number,
  maxRows: number,
): number[] {
  const selectedRows = gridSelection
    ? getSelectedRowIndices(gridSelection)
    : [];
  if (selectedRows.length > 1 && selectedRows.includes(editedRow)) {
    return selectedRows.filter((row) => row >= 0 && row < maxRows);
  }

  if (!gridSelection?.current?.range) {
    return [editedRow];
  }

  const rowsToEdit = new Set<number>();
  const ranges = [
    gridSelection.current.range,
    ...gridSelection.current.rangeStack,
  ];

  for (const { x, y, height, width } of ranges) {
    if (editedCol < x || editedCol >= x + width || height <= 1 || width !== 1) {
      continue;
    }

    for (let i = 0; i < height; i++) {
      const targetRow = y + i;
      if (targetRow >= 0 && targetRow < maxRows) {
        rowsToEdit.add(targetRow);
      }
    }
  }

  return rowsToEdit.size > 0
    ? [...rowsToEdit].sort((left, right) => left - right)
    : [editedRow];
}

/**
 * Returns the row indices currently targeted by grid editing.
 */
export function getEditTargetRowIndices(
  gridSelection: GridSelection | undefined,
  maxRows: number,
): number[] {
  const rows = new Set<number>();

  for (const row of gridSelection ? getSelectedRowIndices(gridSelection) : []) {
    if (row >= 0 && row < maxRows) {
      rows.add(row);
    }
  }

  if (!gridSelection?.current) {
    return [...rows].sort((left, right) => left - right);
  }

  const [editedCol, editedRow] = gridSelection.current.cell;
  for (const row of getRowsToEdit(
    gridSelection,
    editedCol,
    editedRow,
    maxRows,
  )) {
    rows.add(row);
  }

  for (const range of [
    gridSelection.current.range,
    ...gridSelection.current.rangeStack,
  ]) {
    const startRow = Math.max(0, range.y);
    const endRow = Math.min(maxRows, range.y + range.height);
    for (let row = startRow; row < endRow; row += 1) {
      rows.add(row);
    }
  }

  return [...rows].sort((left, right) => left - right);
}
