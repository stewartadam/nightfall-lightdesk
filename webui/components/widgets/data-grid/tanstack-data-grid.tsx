// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type ColumnPinningState,
  createTable,
  functionalUpdate,
  type SortingState,
} from "@tanstack/solid-table";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  mergeProps,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import type {
  GridCell,
  GridColumn,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import { getLogger } from "../../../lib/logger";
import { recordExternalPerformanceMeasure } from "../../../lib/performance-measure-collector";
import { BodyCell } from "./body-cell";
import { createDataGridEditingController } from "./editing-controller";
import { clampIndex, isSpaceKey } from "./event-adapter";
import { HeaderCell } from "./header-cell";
import { createDataGridKeyboardController } from "./keyboard-controller";
import {
  keyedDataGridCellContent,
  keyedDataGridCellContentFn,
} from "./model/cell-provider";
import { cellDisplayValue } from "./model/cell-utils";
import {
  columnId,
  columnWidth,
  type DataGridTableCell,
  type DataGridTableHeader,
  groupColumns,
  sourceGridColumn,
} from "./model/column-model";
import {
  createColumnMeasurementContext,
  sizeColumnsToContent,
} from "./model/column-sizing";
import { createDataGridRowMapping } from "./model/row-order";
import { selectionFromState } from "./model/selection-model";
import { dataGridTableFeatures } from "./model/table-features";
import type { DataGridProps, HeaderCellView, TableRow } from "./model/types";
import { createDataGridPointerEventController } from "./pointer-event-controller";
import "./read-only.css";
import { createDataGridSelectionController } from "./selection-controller";
import {
  createDataGridViewportController,
  observeComputedStyleVisibility,
  styleSize,
} from "./viewport";

const MARKER_WIDTH = 34;
const HEADER_ROW_HEIGHT = 30;
const DEFAULT_ROW_HEIGHT = 30;
const DATA_GRID_MEASURE_PREFIX = "nightfall:data-grid.";
const METRIC_FRAGMENT_PATTERN = /[^a-zA-Z0-9_-]/g;
const log = getLogger(import.meta.url);
const sortCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

type DataGridInstrumentationState = {
  frame: number | undefined;
  cellResolves: number;
  mutationRecords: number;
  addedNodes: number;
  removedNodes: number;
  attributeChanges: number;
  characterDataChanges: number;
  previousRows: number | undefined;
  previousColumns:
    | readonly { id?: string | number; title?: string }[]
    | undefined;
  previousColumnSignature: string | undefined;
  previousCellProvider: ReturnType<DataGridProps["cellProvider"]> | undefined;
  previousProbeValues: Map<string, unknown>;
};

/** Returns a placeholder cell when no data source covers a coordinate. */
function missingCellContent(): GridCell {
  return { kind: GridCellKind.Loading };
}

/** Renders editable or read-only keyed data using shared TanStack layout and interactions. */
export default function TanStackDataGrid(props: DataGridProps) {
  let scrollRef: HTMLDivElement | undefined;
  let rootRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;
  let typeSeekInputRef: HTMLInputElement | undefined;
  let focusedEditKey: string | undefined;
  let handledEditRequestId: number | undefined;
  let handledScrollRequestId: number | undefined;
  const columnMeasurementContext = createColumnMeasurementContext();
  const [horizontalScrollLeft, setHorizontalScrollLeft] = createSignal(0);
  const [computedStyleVisible, setComputedStyleVisible] = createSignal(true);
  const [cellUpdateVersion, setCellUpdateVersion] = createSignal(0);
  let cachedCellProvider: ReturnType<DataGridProps["cellProvider"]> | undefined;
  let contentSizingCache:
    | {
        sourceColumns: readonly GridColumn[];
        contentSizingKey: unknown;
        signature: string;
        customRenderers: DataGridProps["customRenderers"];
        richCellExtensions: DataGridProps["richCellExtensions"];
        columns: readonly GridColumn[];
        widths: readonly number[];
      }
    | undefined;
  const instrumentation: DataGridInstrumentationState = {
    frame: undefined,
    cellResolves: 0,
    mutationRecords: 0,
    addedNodes: 0,
    removedNodes: 0,
    attributeChanges: 0,
    characterDataChanges: 0,
    previousRows: undefined,
    previousColumns: undefined,
    previousColumnSignature: undefined,
    previousCellProvider: undefined,
    previousProbeValues: new Map<string, unknown>(),
  };

  /** Resolves the current row height. */
  const rowHeight = () =>
    props.rowHeight ??
    (props.readOnly
      ? props.density === "compact"
        ? 32
        : 42
      : DEFAULT_ROW_HEIGHT);

  const instrumentationScope = props.performanceScope?.trim();
  const instrumentationEnabled =
    instrumentationScope !== undefined && instrumentationScope.length > 0;

  /** Builds the metrics table key for one DataGrid instrumentation sample. */
  const dataGridMeasureName = (metric: string): string | undefined => {
    if (!instrumentationEnabled) return undefined;
    return `${DATA_GRID_MEASURE_PREFIX}${instrumentationScope}.${metric}`;
  };

  /** Sanitizes owner-provided probe names so metric rows stay predictable. */
  const metricFragment = (value: string): string =>
    value.trim().replace(METRIC_FRAGMENT_PATTERN, "-");

  /** Records one numeric DataGrid instrumentation sample. */
  const recordDataGridCount = (metric: string, value: number) => {
    if (value <= 0) return;
    const name = dataGridMeasureName(metric);
    if (!name) return;
    recordExternalPerformanceMeasure(name, value, "count");
  };

  /** Records one numeric DataGrid gauge sample, allowing zero as a meaningful value. */
  const recordDataGridGauge = (metric: string, value: number) => {
    if (!Number.isFinite(value) || value < 0) return;
    const name = dataGridMeasureName(metric);
    if (!name) return;
    recordExternalPerformanceMeasure(name, value, "count");
  };

  /** Records one DataGrid instrumentation timing sample. */
  const recordDataGridTiming = (metric: string, durationMs: number) => {
    const name = dataGridMeasureName(metric);
    if (!name) return;
    recordExternalPerformanceMeasure(name, durationMs);
  };

  /** Publishes pending grid churn counters once per browser frame. */
  const flushDataGridInstrumentation = () => {
    instrumentation.frame = undefined;
    const cellResolves = instrumentation.cellResolves;
    const mutationRecords = instrumentation.mutationRecords;
    const addedNodes = instrumentation.addedNodes;
    const removedNodes = instrumentation.removedNodes;
    const attributeChanges = instrumentation.attributeChanges;
    const characterDataChanges = instrumentation.characterDataChanges;
    instrumentation.cellResolves = 0;
    instrumentation.mutationRecords = 0;
    instrumentation.addedNodes = 0;
    instrumentation.removedNodes = 0;
    instrumentation.attributeChanges = 0;
    instrumentation.characterDataChanges = 0;

    recordDataGridCount("cell-resolves", cellResolves);
    recordDataGridCount("dom-mutation-records", mutationRecords);
    recordDataGridCount("dom-added-nodes", addedNodes);
    recordDataGridCount("dom-removed-nodes", removedNodes);
    recordDataGridCount("dom-attribute-changes", attributeChanges);
    recordDataGridCount("dom-character-data-changes", characterDataChanges);

    const visibleRows = rowVirtualizer.getVirtualItems().length;
    const visibleColumns =
      Math.min(freezeCount(), leafColumns().length) +
      columnVirtualizer.getVirtualItems().length;
    recordDataGridGauge("visible-rows", visibleRows);
    recordDataGridGauge("visible-cells", visibleRows * visibleColumns);

    const virtualRows = rowVirtualizer.getVirtualItems();
    const firstVirtualRow = virtualRows[0];
    const lastVirtualRow = virtualRows[virtualRows.length - 1];
    if (firstVirtualRow && lastVirtualRow) {
      recordDataGridGauge("virtual-row-start", firstVirtualRow.index);
      recordDataGridGauge("virtual-row-end", lastVirtualRow.index);
    }

    const virtualColumns = columnVirtualizer.getVirtualItems();
    const firstVirtualColumn = virtualColumns[0];
    const lastVirtualColumn = virtualColumns[virtualColumns.length - 1];
    if (firstVirtualColumn && lastVirtualColumn) {
      recordDataGridGauge(
        "virtual-column-start",
        freezeCount() + firstVirtualColumn.index,
      );
      recordDataGridGauge(
        "virtual-column-end",
        freezeCount() + lastVirtualColumn.index,
      );
    }
  };

  /** Schedules the pending grid churn counters to publish after the current frame. */
  const scheduleInstrumentationFlush = () => {
    if (instrumentation.frame !== undefined) return;
    instrumentation.frame = requestAnimationFrame(flushDataGridInstrumentation);
  };

  /** Tracks one rendered body-cell content resolution. */
  const recordBodyCellResolved = () => {
    instrumentation.cellResolves += 1;
    scheduleInstrumentationFlush();
  };

  /** Builds a stable column id signature for diagnosing remount-inducing column changes. */
  const dataGridColumnSignature = (
    nextColumns: readonly { id?: string | number; title?: string }[],
  ) => nextColumns.map((column) => String(column.id ?? column.title)).join("|");

  /** Records a change event when a tracked DataGrid identity changes after initialization. */
  const recordIdentityChange = (metric: string, didChange: boolean) => {
    if (!didChange) return;
    recordDataGridCount(metric, 1);
  };

  /** Returns whether the leading row marker column should be visible. */
  const markerEnabled = () =>
    props.rowMarkers !== undefined && props.rowMarkers !== "none";

  /** Supplies the latest provider while visible and the last visible provider while hidden. */
  const effectiveCellProvider = createMemo(() => {
    const cachedProvider = cachedCellProvider;
    if (!computedStyleVisible() && cachedProvider) {
      return cachedProvider;
    }

    const nextProvider = props.cellProvider();
    cachedCellProvider = nextProvider;
    return nextProvider;
  });

  /** Invalidates TanStack value caches when keyed source data changes. */
  const rowData = createMemo<TableRow[]>(() => {
    effectiveCellProvider();
    return Array.from({ length: props.rows }, (_, rowIndex) => ({ rowIndex }));
  });
  const [internalSorting, setInternalSorting] = createSignal<SortingState>([]);
  /** Resolves controlled or locally owned header sorting. */
  const sorting = () => props.sorting ?? internalSorting();

  /** Builds a stable signature for inputs that can change intrinsic column widths. */
  const contentSizingSignature = (
    sourceColumns: readonly GridColumn[],
    rowCount: number,
  ): string =>
    JSON.stringify({
      nested: props.nestedColumnGroups === true,
      columns: sourceColumns.map((column) => ({
        id: columnId(column),
        title: column.title,
        sizing: column.sizing ?? "content",
        minWidth: column.minWidth,
        maxWidth: column.maxWidth,
        group: column.group,
        visibilityCategory: (column as { visibilityCategory?: string })
          .visibilityCategory,
        visibilityGroup: (column as { visibilityGroup?: string })
          .visibilityGroup,
        visibilityGroupLabel: (column as { visibilityGroupLabel?: string })
          .visibilityGroupLabel,
        fallbackWidth:
          column.sizing === "fixed" || rowCount === 0
            ? column.width
            : undefined,
      })),
    });

  /** Resolves intrinsic widths once per data row set and structural column definition. */
  const contentSizedColumns = createMemo(() => {
    const sourceColumns = props.columns;
    const provider = effectiveCellProvider();
    const context = columnMeasurementContext;
    if (!context) return sourceColumns;

    const signature = contentSizingSignature(
      sourceColumns,
      provider.rows.length,
    );
    const contentSizingKey = provider.contentSizingKey ?? provider;
    const cached = contentSizingCache;
    if (
      cached?.contentSizingKey === contentSizingKey &&
      cached.signature === signature &&
      cached.customRenderers === props.customRenderers &&
      cached.richCellExtensions === props.richCellExtensions
    ) {
      if (cached.sourceColumns === sourceColumns) return cached.columns;

      const columns = sourceColumns.map((column, index) => ({
        ...column,
        width: cached.widths[index] ?? columnWidth(column),
      }));
      contentSizingCache = { ...cached, sourceColumns, columns };
      return columns;
    }

    const sized = sizeColumnsToContent({
      columns: sourceColumns,
      provider,
      context,
      customRenderers: props.customRenderers,
      richCellExtensions: props.richCellExtensions,
      nestedColumnGroups: props.nestedColumnGroups === true,
    });
    contentSizingCache = {
      sourceColumns,
      contentSizingKey,
      signature,
      customRenderers: props.customRenderers,
      richCellExtensions: props.richCellExtensions,
      columns: sized,
      widths: sized.map((column) => columnWidth(column)),
    };
    return sized;
  });

  /** Adds typed sorting accessors to the same column tree used for layout and resizing. */
  const columnDefs = createMemo(() => {
    const columns = contentSizedColumns();
    const definitions = groupColumns(
      columns,
      props.nestedColumnGroups === true,
    );
    const sortable = new Set(props.sortableColumns ?? []);
    const sourceIndexes = new Map(
      columns.map((column, index) => [columnId(column), index]),
    );
    /** Configures each leaf while preserving grouped header structure. */
    const configure = (items: readonly (typeof definitions)[number][]) => {
      for (const definition of items) {
        if ("columns" in definition && definition.columns)
          configure(definition.columns);
        definition.enableSorting = sortable.has(definition.id!);
        if (!definition.enableSorting) continue;
        const index = sourceIndexes.get(definition.id!);
        if (index === undefined) continue;
        definition.sortDescFirst = false;
        definition.sortUndefined = "last";
        Object.assign(definition, {
          /** Resolves raw numbers and booleans, or the copyable display text for rich cells. */
          accessorFn: (row: TableRow) => {
            const cell = keyedDataGridCellContent(effectiveCellProvider(), [
              index,
              row.rowIndex,
            ]);
            if (!cell || cell.kind === GridCellKind.Loading) return undefined;
            return cell.kind === GridCellKind.Number ||
              cell.kind === GridCellKind.Boolean
              ? cell.data
              : cellDisplayValue(cell);
          },
        });
        /** Orders typed values without sorting formatted numbers lexicographically. */
        definition.sortFn = (left, right, id) => {
          const a = left.getValue<unknown>(id);
          const b = right.getValue<unknown>(id);
          if (typeof a === "number" && typeof b === "number") return a - b;
          if (typeof a === "boolean" && typeof b === "boolean")
            return Number(a) - Number(b);
          return sortCollator.compare(String(a ?? ""), String(b ?? ""));
        };
      }
    };
    configure(definitions);
    return definitions;
  });
  const columnPinning = createMemo<ColumnPinningState>(() => {
    const columns = contentSizedColumns();
    const count = Math.min(props.freezeColumns ?? 0, columns.length);
    return {
      start: columns.slice(0, count).map((column) => columnId(column)),
      end: [],
    };
  });
  const table = createTable({
    features: dataGridTableFeatures,
    get data() {
      return rowData();
    },
    get columns() {
      return columnDefs();
    },
    state: {
      get sorting() {
        return sorting();
      },
      get columnPinning() {
        return columnPinning();
      },
    },
    defaultColumn: {
      minSize: 36,
      size: 120,
    },
    getRowId: (row) => {
      const key = effectiveCellProvider().rowKeys[row.rowIndex];
      return key === undefined
        ? `missing:${row.rowIndex}`
        : `${typeof key}:${key}`;
    },
    get enableSorting() {
      return props.readOnly === true;
    },
    get manualSorting() {
      return props.readOnly !== true;
    },
    enableMultiSort: false,
    onSortingChange: (updater) => {
      const next = functionalUpdate(updater, sorting());
      setInternalSorting(next);
      props.onSortingChange?.(next);
    },
    columnResizeMode: "onChange",
  });
  const leafColumns = createMemo(() => table.getAllLeafColumns());
  /** Remeasures one column using current cells while preserving its neighbors' widths. */
  const autoSizeColumn = (header: HeaderCellView) => {
    if (!columnMeasurementContext) return;
    const index = header.firstLeafIndex;
    const column = leafColumns()[index];
    if (!column?.getCanResize()) return;

    const sized = sizeColumnsToContent({
      columns: props.columns.map((source, sourceIndex) => ({
        ...source,
        width: leafColumns()[sourceIndex]?.getSize() ?? columnWidth(source),
        sizing: sourceIndex === index ? "content" : "fixed",
      })),
      provider: effectiveCellProvider(),
      context: columnMeasurementContext,
      customRenderers: props.customRenderers,
      richCellExtensions: props.richCellExtensions,
      nestedColumnGroups: props.nestedColumnGroups === true,
    });
    table.setColumnSizing((current) => ({
      ...current,
      [column.id]: columnWidth(sized[index]!),
    }));
  };
  const startColumns = createMemo(() => table.getStartVisibleLeafColumns());
  const centerColumns = createMemo(() => table.getCenterVisibleLeafColumns());
  const startColumnIds = createMemo(() =>
    startColumns().map((column) => column.id),
  );
  const tableRows = createMemo(() => table.getRowModel().rows);
  /** Identifies each visible position independently of its source array position. */
  const orderedRowKeys = createMemo(() =>
    tableRows().map(
      (row) => effectiveCellProvider().rowKeys[row.original.rowIndex],
    ),
  );
  /** Translates visible coordinates back into the caller's source provider. */
  const viewToSource = createMemo(() =>
    createDataGridRowMapping(orderedRowKeys(), effectiveCellProvider().rowKeys),
  );
  /** Translates source requests into the current sorted view. */
  const sourceToView = createMemo(() =>
    createDataGridRowMapping(effectiveCellProvider().rowKeys, orderedRowKeys()),
  );
  /** Publishes selection using source rows, including fragmented sorted ranges. */
  const publishSelection = (selection: GridSelection) =>
    props.onGridSelectionChange?.(viewToSource().selection(selection));
  const viewProps = mergeProps(props, {
    onGridSelectionChange: publishSelection,
    get onCellClicked() {
      return props.onCellClicked
        ? (
            cell: Item,
            event: Parameters<NonNullable<DataGridProps["onCellClicked"]>>[1],
          ) => {
            const source = viewToSource().cell(cell);
            if (source) props.onCellClicked?.(source, event);
          }
        : undefined;
    },
    get onCellContextMenu() {
      return props.onCellContextMenu
        ? (
            cell: Item,
            event: Parameters<
              NonNullable<DataGridProps["onCellContextMenu"]>
            >[1],
          ) => {
            const source = viewToSource().cell(cell);
            if (source) props.onCellContextMenu?.(source, event);
          }
        : undefined;
    },
    get onCellHovered() {
      return props.onCellHovered
        ? (cell: Item | undefined, element?: HTMLElement) =>
            props.onCellHovered?.(viewToSource().cell(cell), element)
        : undefined;
    },
    get cellDecorations() {
      return props.cellDecorations
        ? (
            args: Parameters<NonNullable<DataGridProps["cellDecorations"]>>[0],
          ) => {
            const row = viewToSource().row(args.row);
            if (row !== undefined) props.cellDecorations?.({ ...args, row });
          }
        : undefined;
    },
  });
  const headerRows = createMemo(() => table.getHeaderGroups());
  const freezeCount = createMemo(() => startColumns().length);
  const columnIndexById = createMemo(
    () => new Map(leafColumns().map((column, index) => [column.id, index])),
  );

  /** Returns the CSS custom property carrying one leaf column's live size. */
  const columnWidthVariable = (columnIndex: number): string =>
    `--data-grid-column-${columnIndex}-width`;

  /** Returns the CSS custom property carrying one header's live span size. */
  const headerWidthVariable = (header: DataGridTableHeader): string =>
    `--data-grid-header-${header.depth}-${header.index}-width`;

  /** Publishes all reactive TanStack sizes through one memoized style object. */
  const tableSizingStyles = createMemo(() => {
    const styles: Record<string, string> = {};
    for (const [index, column] of leafColumns().entries()) {
      styles[columnWidthVariable(index)] = `${column.getSize()}px`;
    }
    for (const headerRow of headerRows()) {
      for (const header of headerRow.headers) {
        styles[headerWidthVariable(header)] = `${header.getSize()}px`;
      }
    }
    return styles as JSX.CSSProperties;
  });
  /** Returns the viewport-space edge after the frozen marker and data columns. */
  const frozenColumnsRight = createMemo(
    () => (markerEnabled() ? MARKER_WIDTH : 0) + table.getStartTotalSize(),
  );
  /** Returns the portion of a scrollable header hidden beneath frozen columns. */
  const headerObscuredWidth = (
    header: DataGridTableHeader,
    view: HeaderCellView,
  ): number => {
    if (view.firstLeafIndex < freezeCount()) return 0;
    const firstLeaf = leafColumns()[view.firstLeafIndex];
    const logicalLeft =
      frozenColumnsRight() + (firstLeaf?.getStart("center") ?? 0);
    const viewportLeft = logicalLeft - horizontalScrollLeft();
    return Math.max(
      0,
      Math.min(header.getSize(), frozenColumnsRight() - viewportLeft),
    );
  };

  /** Derives the narrow callback view for a TanStack header. */
  const headerCellView = (header: DataGridTableHeader): HeaderCellView => {
    const leafIndexes = header
      .getLeafHeaders()
      .map((leafHeader) => columnIndexById().get(leafHeader.column.id))
      .filter((index): index is number => index !== undefined);
    const fallbackIndex = columnIndexById().get(header.column.id) ?? 0;
    const firstLeafIndex =
      leafIndexes.length > 0 ? Math.min(...leafIndexes) : fallbackIndex;
    const endLeafIndex =
      leafIndexes.length > 0 ? Math.max(...leafIndexes) + 1 : fallbackIndex + 1;
    return {
      id: header.column.id,
      label: header.column.columnDef.meta?.label ?? "",
      firstLeafIndex,
      endLeafIndex,
    };
  };

  /** Builds the stable DOM hook for one real or placeholder TanStack header. */
  const headerDomId = (
    header: DataGridTableHeader,
    view: HeaderCellView,
  ): string =>
    header.isPlaceholder
      ? `tanstack-header-placeholder-${header.depth}-${view.firstLeafIndex}`
      : `tanstack-header-${header.column.id}`;
  const primaryColumnIndex = () =>
    clampIndex(props.primaryColumnIndex ?? 0, leafColumns().length);

  /** Resolves source cells and applies the grid-wide read-only policy to every renderer. */
  const getCellContent = createMemo(() => {
    const sourceContent = keyedDataGridCellContentFn(
      effectiveCellProvider(),
      missingCellContent,
    );
    const mapping = viewToSource();
    /** Resolves a displayed cell through the current row order. */
    const resolve = (cell: Item) => {
      const source = mapping.cell(cell);
      return source ? sourceContent(source) : missingCellContent();
    };
    return props.readOnly
      ? (cell: readonly [number, number]): GridCell => ({
          ...resolve(cell),
          readonly: true,
          allowOverlay: false,
        })
      : resolve;
  });
  const editingController = createDataGridEditingController({
    props: viewProps,
    selectionState: () => selectionState(),
    dispatchSelection: (action) => dispatchSelection(action),
    getCellContent,
    columnCount: () => leafColumns().length,
    focusRoot: () => focusRoot(),
  });
  const {
    beginEdit,
    cancelEdit,
    commitDiscreteEdit,
    commitEdit,
    editingCell,
    setEditingCell,
  } = editingController;
  const selectionController = createDataGridSelectionController({
    editingCell,
    getCellContent,
    primaryColumnIndex,
    focusRoot: () => focusRoot(),
    scrollCellIntoView: (cell) => scrollCellIntoView(cell),
    onCellClicked: viewProps.onCellClicked,
    onGridSelectionChange: publishSelection,
  });
  const {
    activeCell,
    beginDragSelection,
    currentSelection,
    dispatchSelection,
    selectedColumnSet,
    selectedRowSet,
    selectionState,
    selectCell,
  } = selectionController;
  const currentRangeData = createMemo(() => {
    const range = currentSelection()?.range;
    if (!range) return "";
    return `${range.x},${range.y},${range.width},${range.height}`;
  });
  const viewportController = createDataGridViewportController({
    rows: tableRows,
    rowHeight,
    headerRowCount: () => headerRows().length,
    headerRowHeight: HEADER_ROW_HEIGHT,
    markerWidth: () => (markerEnabled() ? MARKER_WIDTH : 0),
    columns: leafColumns,
    centerColumns,
    startWidth: () => table.getStartTotalSize(),
    centerWidth: () => table.getCenterTotalSize(),
    scrollElement: () => scrollRef,
  });
  const {
    columnVirtualizer,
    leadingVirtualColumnSpacerWidth,
    rowVirtualizer,
    scrollableVirtualColumnIndexes,
    scrollCellIntoView,
    topVisibleBodyRow,
    trailingVirtualColumnSpacerWidth,
    virtualRowByIndex,
    virtualRowIndexes,
  } = viewportController;

  let previousColumnSizing: Record<string, number> = {};
  /** Bridges TanStack-owned sizing changes back to the optional grid callback. */
  createEffect(() => {
    const nextColumnSizing = table.atoms.columnSizing?.get() ?? {};
    const changedColumnIds = new Set([
      ...Object.keys(previousColumnSizing),
      ...Object.keys(nextColumnSizing),
    ]);
    for (const id of changedColumnIds) {
      if (previousColumnSizing[id] === nextColumnSizing[id]) continue;
      const tableColumn = leafColumns().find((column) => column.id === id);
      const sourceColumn = sourceGridColumn(tableColumn);
      if (!tableColumn || !sourceColumn) continue;
      const width = tableColumn.getSize();
      props.onColumnResize?.({ ...sourceColumn, width }, width);
    }
    previousColumnSizing = { ...nextColumnSizing };
  });

  if (instrumentationEnabled) {
    /** Tracks row count changes that can alter virtualization and remount pressure. */
    createEffect(() => {
      const nextRows = props.rows;
      recordDataGridGauge("rows", nextRows);
      recordIdentityChange(
        "row-count-changes",
        instrumentation.previousRows !== undefined &&
          instrumentation.previousRows !== nextRows,
      );
      instrumentation.previousRows = nextRows;
    });

    /** Tracks column reference and signature changes that can remount visible cells. */
    createEffect(() => {
      const nextColumns = leafColumns();
      const nextSignature = dataGridColumnSignature(nextColumns);
      recordDataGridGauge("columns", nextColumns.length);
      recordIdentityChange(
        "column-reference-changes",
        instrumentation.previousColumns !== undefined &&
          instrumentation.previousColumns !== nextColumns,
      );
      recordIdentityChange(
        "column-signature-changes",
        instrumentation.previousColumnSignature !== undefined &&
          instrumentation.previousColumnSignature !== nextSignature,
      );
      instrumentation.previousColumns = nextColumns;
      instrumentation.previousColumnSignature = nextSignature;
    });

    /** Tracks cell-provider identity changes separately from raw invalidation churn. */
    createEffect(() => {
      if (!computedStyleVisible()) return;
      const nextCellProvider = effectiveCellProvider();
      recordIdentityChange(
        "cell-provider-changes",
        instrumentation.previousCellProvider !== undefined &&
          instrumentation.previousCellProvider !== nextCellProvider,
      );
      instrumentation.previousCellProvider = nextCellProvider;
    });

    /** Tracks owner-provided probe identities to attribute invalidation sources. */
    createEffect(() => {
      const probes = props.performanceProbes;
      if (!probes) return;

      const nextProbeNames = new Set(Object.keys(probes));
      for (const [name, value] of Object.entries(probes)) {
        const previousValue = instrumentation.previousProbeValues.get(name);
        if (
          instrumentation.previousProbeValues.has(name) &&
          !Object.is(previousValue, value)
        ) {
          recordDataGridCount(`probe.${metricFragment(name)}.changes`, 1);
        }
        instrumentation.previousProbeValues.set(name, value);
      }

      for (const name of instrumentation.previousProbeValues.keys()) {
        if (!nextProbeNames.has(name)) {
          instrumentation.previousProbeValues.delete(name);
        }
      }
    });

    /** Measures the latency from grid invalidation to the next browser frame. */
    createEffect(() => {
      void props.rows;
      void leafColumns().length;

      const startedAtMs = performance.now();
      requestAnimationFrame(() => {
        recordDataGridTiming(
          "update-to-frame",
          performance.now() - startedAtMs,
        );
      });
    });
  }

  /** Selects the leaf columns covered by a header model entry. */
  const selectHeaderColumns = (header: HeaderCellView) => {
    if (header.endLeafIndex <= header.firstLeafIndex) return false;
    dispatchSelection({
      type: "selectColumnRange",
      start: header.firstLeafIndex,
      endExclusive: header.endLeafIndex,
      activeRow: topVisibleBodyRow(),
    });
    focusRoot();
    return true;
  };

  /** Restores keyboard focus to the grid root once editing has settled. */
  const focusRoot = () => {
    if (!editingCell()) {
      rootRef?.focus();
    }
    requestAnimationFrame(() => {
      if (editingCell()) return;
      rootRef?.focus();
    });
  };

  const keyboardController = createDataGridKeyboardController({
    props: viewProps,
    columns: leafColumns,
    primaryColumnIndex,
    getCellContent,
    rootElement: () => rootRef,
    scrollElement: () => scrollRef,
    editingController,
    selectionController,
    viewportController,
    focusRoot,
  });
  const {
    finishTypeSeek,
    handleCopy,
    handleDocumentGridKeyDown,
    handleDocumentKeyDown,
    handlePaste,
    resetTypeSeek,
    typeSeekActive,
    typeSeekInputLeft,
    typeSeekText,
    updateTypeSeekText,
  } = keyboardController;

  const pointerEventController = createDataGridPointerEventController({
    props: viewProps,
    editingController,
    selectionController,
    focusRoot,
  });
  const { handleCellClick, handleCellEnterKey } = pointerEventController;

  /** Toggles a row marker selection, including shift range selection. */
  const toggleRowSelection = (row: number, event: MouseEvent) => {
    dispatchSelection({ type: "toggleRow", row, extend: event.shiftKey });
  };

  /** Renders one TanStack body cell with selection, editing, decoration, and sticky state. */
  const renderBodyCell = (cell: DataGridTableCell, rowIndex: number) => {
    const col = columnIndexById().get(cell.column.id);
    if (col === undefined) return null;
    return (
      <BodyCell
        col={col}
        rowIndex={rowIndex}
        column={() => cell.column}
        columnWidthVariable={columnWidthVariable(col)}
        columnKey={() => effectiveCellProvider().columnKeys[col]}
        rowKey={() => orderedRowKeys()[rowIndex]}
        activeCell={activeCell}
        beginDragSelection={beginDragSelection}
        beginEdit={beginEdit}
        cancelEdit={cancelEdit}
        cellDecorations={viewProps.cellDecorations}
        commitEdit={commitEdit}
        currentSelection={currentSelection}
        customRenderers={props.customRenderers}
        richCellExtensions={props.richCellExtensions}
        editingCell={editingCell}
        cellsUpdating={computedStyleVisible}
        cellUpdateVersion={cellUpdateVersion}
        getCellContent={getCellContent}
        handleCellClick={handleCellClick}
        handleCellEnterKey={handleCellEnterKey}
        decorationInvalidateKey={props.decorationInvalidateKey}
        onCellResolved={
          instrumentationEnabled ? recordBodyCellResolved : undefined
        }
        onCellHovered={viewProps.onCellHovered}
        onCellContextMenu={viewProps.onCellContextMenu}
        onCellEdited={props.readOnly ? undefined : props.onCellEdited}
        inlineEditTooltip={props.inlineEditTooltip}
        commitDiscreteEdit={commitDiscreteEdit}
        rowHeight={rowHeight}
        rowCount={() => props.rows}
        columnCount={() => leafColumns().length}
        selectedColumnSet={selectedColumnSet}
        selectedRowSet={selectedRowSet}
        selectCell={selectCell}
        setActiveCell={(cell) =>
          dispatchSelection({ type: "setActiveCell", cell })
        }
        setEditingCell={setEditingCell}
        setInputRef={(element) => {
          inputRef = element;
        }}
        stickyLeft={() =>
          (markerEnabled() ? MARKER_WIDTH : 0) + cell.column.getStart("start")
        }
      />
    );
  };

  let previousRowKeys = orderedRowKeys();
  /** Follows stable row identities through sorting and live source updates. */
  createEffect(() => {
    const next = orderedRowKeys();
    if (
      next.length === previousRowKeys.length &&
      next.every((key, index) => key === previousRowKeys[index])
    )
      return;
    const mapping = createDataGridRowMapping(previousRowKeys, next);
    previousRowKeys = next;
    untrack(() => {
      selectionController.dispose();
      if (editingCell()) cancelEdit();
      const state = mapping.state(selectionState());
      selectionController.setSelectionState(state);
      publishSelection(selectionFromState(state));
    });
  });

  /** Mirrors explicitly changed source selection into the current display order. */
  createEffect(() => {
    const selection = props.gridSelection;
    dispatchSelection({
      type: "syncExternalSelection",
      selection: selection
        ? untrack(() => sourceToView().selection(selection))
        : undefined,
    });
  });

  /** Starts inline editing when an owner component requests a specific cell. */
  createEffect(() => {
    const request = props.editRequest;
    if (!request || handledEditRequestId === request.requestId) return;
    handledEditRequestId = request.requestId;
    beginEdit(request.cell[0], request.cell[1]);
  });

  /** Scrolls a target cell into view when an owner component requests it. */
  createEffect(() => {
    const request = props.scrollRequest;
    if (!request || handledScrollRequestId === request.requestId) return;
    handledScrollRequestId = request.requestId;
    const cell = sourceToView().cell(request.cell);
    if (cell) scrollCellIntoView(cell);
  });

  /** Focuses the inline editor input when editing starts or moves cells. */
  createEffect(() => {
    const editing = editingCell();
    if (!editing) {
      focusedEditKey = undefined;
      return;
    }
    if (editing.kind === "dropdown" || editing.kind === "rich") {
      focusedEditKey = `${editing.col}:${editing.row}:${editing.kind}`;
      return;
    }
    if (
      editing.kind !== GridCellKind.Text &&
      editing.kind !== GridCellKind.Number
    ) {
      return;
    }
    if (!inputRef) return;
    const editKey = `${editing.col}:${editing.row}:${editing.selectOnFocus ? "select" : "cursor"}`;
    if (focusedEditKey === editKey) return;
    focusedEditKey = editKey;
    inputRef.focus();
    if (editing.selectOnFocus) {
      inputRef.select();
      return;
    }
    const cursor = inputRef.value.length;
    inputRef.setSelectionRange(cursor, cursor);
  });

  /** Focuses the fixture ID seek input when type-seek mode opens. */
  createEffect(() => {
    if (!typeSeekActive()) return;
    typeSeekInputRef?.focus();
    typeSeekInputRef?.select();
  });

  /** Installs document keyboard listeners and visibility instrumentation. */
  onMount(() => {
    document.addEventListener("keydown", handleDocumentGridKeyDown, true);
    document.addEventListener("keydown", handleDocumentKeyDown, true);
    const visibilityRoot = rootRef;
    const disposeComputedVisibilityObserver = visibilityRoot
      ? observeComputedStyleVisibility(visibilityRoot, (visible) => {
          const previousVisible = untrack(computedStyleVisible);
          setComputedStyleVisible(visible);
          if (!previousVisible && visible) {
            setCellUpdateVersion((version) => version + 1);
          }
          const panelElement =
            visibilityRoot.closest<HTMLElement>("[data-panel-kind]");
          const panelKind = panelElement?.dataset.panelKind ?? "unknown";
          const panelId = panelElement?.dataset.panelId;
          const debugScope = props.performanceScope?.trim() || "unspecified";
          log.debug(
            `Visibility: panel=${panelKind}${panelId ? ` id=${panelId}` : ""}, scope=${debugScope}, computedStyle=${visible} -> ${visible ? "refreshing" : "paused"}`,
          );
        })
      : undefined;
    const mutationRoot = rootRef;
    const mutationObserver =
      "MutationObserver" in window && mutationRoot && instrumentationEnabled
        ? new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              instrumentation.mutationRecords += 1;
              instrumentation.addedNodes += mutation.addedNodes.length;
              instrumentation.removedNodes += mutation.removedNodes.length;
              if (mutation.type === "attributes") {
                instrumentation.attributeChanges += 1;
              } else if (mutation.type === "characterData") {
                instrumentation.characterDataChanges += 1;
              }
            }
            scheduleInstrumentationFlush();
          })
        : undefined;
    if (mutationRoot) {
      mutationObserver?.observe(mutationRoot, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
    onCleanup(() => {
      selectionController.dispose();
      document.removeEventListener("keydown", handleDocumentGridKeyDown, true);
      document.removeEventListener("keydown", handleDocumentKeyDown, true);
      mutationObserver?.disconnect();
      if (instrumentation.frame !== undefined) {
        cancelAnimationFrame(instrumentation.frame);
        instrumentation.frame = undefined;
      }
      disposeComputedVisibilityObserver?.();
      resetTypeSeek();
    });
  });

  return (
    <div
      ref={rootRef}
      role="grid"
      aria-readonly={props.readOnly === true}
      aria-label={props.ariaLabel}
      data-column-guides={props.columnGuides}
      tabIndex={0}
      data-selection-range={currentRangeData()}
      data-grid-model-column-count={leafColumns().length}
      data-grid-model-row-count={tableRows().length}
      class={`h-full w-full select-none overflow-hidden bg-[#16161b] text-[13px] text-white outline-none ${props.class ?? ""}`}
      onCopy={handleCopy}
      onPaste={handlePaste}
      style={{
        width: styleSize(props.width, "100%"),
        height: styleSize(props.height, "100%"),
        "--data-grid-column-border":
          props.columnGuides === undefined
            ? undefined
            : props.columnGuides
              ? "var(--line, #34383b)"
              : "transparent",
      }}
    >
      <div
        ref={scrollRef}
        data-grid-kind="tanstack"
        data-grid-model-column-count={leafColumns().length}
        data-grid-model-row-count={tableRows().length}
        class="h-full w-full overflow-auto"
        onScroll={(event) => {
          setHorizontalScrollLeft(event.currentTarget.scrollLeft);
        }}
      >
        <div
          class="relative min-w-full"
          style={{
            ...tableSizingStyles(),
            width: `${(markerEnabled() ? MARKER_WIDTH : 0) + table.getTotalSize()}px`,
          }}
        >
          <Show when={typeSeekActive() && leafColumns().length > 0}>
            <div class="pointer-events-none sticky top-0 z-50 h-0">
              <input
                ref={typeSeekInputRef}
                type="text"
                aria-label="Fixture ID seek"
                value={typeSeekText()}
                class="pointer-events-auto absolute top-1 h-7 rounded border border-blue-400 bg-[#0f172a] px-2 font-mono text-sm text-white shadow-lg outline-none ring-2 ring-blue-500/40"
                style={{
                  left: `${typeSeekInputLeft()}px`,
                  width: `${leafColumns()[primaryColumnIndex()]?.getSize() ?? 0}px`,
                }}
                onInput={(event) => {
                  updateTypeSeekText(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    finishTypeSeek(true);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    finishTypeSeek(false);
                  }
                }}
                onBlur={() => {
                  if (typeSeekActive()) {
                    finishTypeSeek(false);
                  }
                }}
              />
            </div>
          </Show>
          <div class="sticky top-0 z-30 bg-[#212121]">
            <For each={headerRows()}>
              {(headerRow) => {
                return (
                  <div class="flex h-[30px] border-b border-white/20">
                    <Show when={markerEnabled() && headerRow.depth === 0}>
                      <div
                        class="sticky left-0 z-40 flex shrink-0 items-center justify-center border-r border-white/20 bg-[#212121]"
                        style={{ width: `${MARKER_WIDTH}px` }}
                      />
                    </Show>
                    <Show when={markerEnabled() && headerRow.depth > 0}>
                      <div
                        class="sticky left-0 z-40 shrink-0 border-r border-white/20 bg-[#212121]"
                        style={{ width: `${MARKER_WIDTH}px` }}
                      />
                    </Show>
                    <For each={headerRow.headers}>
                      {(header) => {
                        const view = headerCellView(header);
                        const firstLeaf = leafColumns()[view.firstLeafIndex];
                        const sticky =
                          view.endLeafIndex <= freezeCount() &&
                          view.firstLeafIndex < view.endLeafIndex;
                        return (
                          <HeaderCell
                            header={header}
                            view={view}
                            headerId={headerDomId(header, view)}
                            content={
                              <Show when={!header.isPlaceholder}>
                                <table.FlexRender header={header} />
                              </Show>
                            }
                            widthVariable={headerWidthVariable(header)}
                            sticky={sticky}
                            left={
                              (markerEnabled() ? MARKER_WIDTH : 0) +
                              (sticky ? (firstLeaf?.getStart("start") ?? 0) : 0)
                            }
                            obscuredWidth={headerObscuredWidth(header, view)}
                            selectedColumnSet={selectedColumnSet()}
                            isActivationKey={(event) =>
                              event.key === "Enter" || isSpaceKey(event)
                            }
                            onSelectColumns={selectHeaderColumns}
                            onResizeColumn={(id, width) =>
                              table.setColumnSizing((current) => ({
                                ...current,
                                [id]: width,
                              }))
                            }
                            onAutoSizeColumn={autoSizeColumn}
                            onGroupHeaderClicked={props.onGroupHeaderClicked}
                            onColumnHeaderContextMenu={
                              props.onColumnHeaderContextMenu
                            }
                          />
                        );
                      }}
                    </For>
                  </div>
                );
              }}
            </For>
          </div>

          <Show when={tableRows().length === 0 && props.emptyState}>
            <div
              role="status"
              class="sticky left-0 w-fit max-w-full p-4 text-sm text-neutral-400"
            >
              {props.emptyState}
            </div>
          </Show>
          <div
            class="relative"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            <For each={virtualRowIndexes()}>
              {(rowModelIndex) => {
                const tableRow = () => tableRows()[rowModelIndex];
                const rowIndex = () => rowModelIndex;
                if (rowIndex() === undefined) return null;
                const virtualRow = () => virtualRowByIndex().get(rowModelIndex);
                return (
                  <div
                    class="absolute left-0 flex"
                    style={{
                      height: `${virtualRow()?.size ?? rowHeight()}px`,
                      transform: `translateY(${virtualRow()?.start ?? 0}px)`,
                    }}
                  >
                    <Show when={markerEnabled()}>
                      <label
                        class="sticky left-0 z-20 flex shrink-0 items-center justify-center border-r border-b border-white/20 bg-[#181820]"
                        style={{ width: `${MARKER_WIDTH}px` }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedRowSet().has(rowIndex()!)}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleRowSelection(rowIndex()!, event);
                            focusRoot();
                          }}
                          aria-label={`Select row ${rowIndex()! + 1}`}
                          class="size-4"
                        />
                      </label>
                    </Show>
                    <For each={startColumnIds()}>
                      {(columnId) => {
                        const cell = () =>
                          tableRow()?.getAllCellsByColumnId()[columnId];
                        return (
                          <Show when={cell()}>
                            {(resolvedCell) =>
                              renderBodyCell(resolvedCell(), rowModelIndex)
                            }
                          </Show>
                        );
                      }}
                    </For>
                    <div
                      aria-hidden="true"
                      class="shrink-0 border-b border-white/15"
                      style={{
                        width: `${leadingVirtualColumnSpacerWidth()}px`,
                        height: `${rowHeight()}px`,
                      }}
                    />
                    <For each={scrollableVirtualColumnIndexes()}>
                      {(centerColumnIndex) => {
                        const columnId = () =>
                          centerColumns()[centerColumnIndex]?.id;
                        const cell = () => {
                          const id = columnId();
                          return id
                            ? tableRow()?.getAllCellsByColumnId()[id]
                            : undefined;
                        };
                        return (
                          <Show when={cell()}>
                            {(resolvedCell) =>
                              renderBodyCell(resolvedCell(), rowModelIndex)
                            }
                          </Show>
                        );
                      }}
                    </For>
                    <div
                      aria-hidden="true"
                      class="shrink-0 border-b border-white/15"
                      style={{
                        width: `${trailingVirtualColumnSpacerWidth()}px`,
                        height: `${rowHeight()}px`,
                      }}
                    />
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}
