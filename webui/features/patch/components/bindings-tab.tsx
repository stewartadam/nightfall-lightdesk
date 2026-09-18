// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import Tooltip from "../../../components/ui/tooltip";
import DataGrid, {
  createKeyedDataGridCellProvider,
  type DataGridCellDecorationCallback,
  drawConflictWarningIcon,
} from "../../../components/widgets/data-grid";
import ColumnVisibilityMenu from "../../../components/widgets/data-grid/extensions/column-visibility-menu";
import DataGridFilterMenu from "../../../components/widgets/data-grid/extensions/data-grid-filter-menu";
import { createDataGridFilterState } from "../../../components/widgets/data-grid/extensions/model/data-grid-filter-state";
import { computeBindingOverlapAnalysis } from "../../../lib/binding-overlap";
import type {
  GridCell,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { CompactSelection, GridCellKind } from "../../../lib/data-grid-types";
import {
  CONFLICT_VALUE_TEXT_COLOR,
  createRowSelectionHelpers,
  emptyGridSelection,
  getEditTargetRowIndices,
  makeSafeTextCell,
} from "../../../lib/datagrid";
import {
  filterVisibleColumns,
  type VisibilityGridColumn,
} from "../../../lib/datagrid-column-visibility";
import { filterColumnsFromMetadata } from "../../../lib/datagrid-filtering";
import { sendRemovePatchBinding } from "../../../lib/fixture-service";
import { bindings, dmxUniverseData, fixtures } from "../../../state/appStores";
import {
  type BindingDeleteFilter,
  type BindingRow,
  type ConflictTooltipState,
  DEFAULT_COLUMNS,
  isBindingConflictColumn,
  toDisabledBindingRow,
  toInputBindingRow,
  toOutputBindingRow,
} from "../model/bindings-model";

export interface PatchBindingsTabProps {
  panelId: string;
  onSelectionCountChange?: (count: number) => void;
  onDeleteActionChange?: (action: (() => void) | null) => void;
  navigateToBinding?: { bindingId: string; requestId: number } | null;
  onNavigateHandled?: (requestId: number) => void;
  onColumnVisibilityControlChange?: (control: JSX.Element | null) => void;
}

export default function PatchBindingsTab(props: PatchBindingsTabProps) {
  const $bindings = useStore(bindings);
  const $fixtures = useStore(fixtures);
  const $dmxUniverseData = useStore(dmxUniverseData);
  const [columns, setColumns] =
    createSignal<VisibilityGridColumn[]>(DEFAULT_COLUMNS);
  const displayColumns = createMemo(() => {
    return filterVisibleColumns(columns(), props.panelId);
  });
  const [selection, setSelection] = createSignal<GridSelection>(
    emptyGridSelection(),
  );
  const [conflictTooltip, setConflictTooltip] =
    createSignal<ConflictTooltipState>();
  let conflictTooltipTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let conflictTooltipId = 0;
  const { clearSelection, handleGridSelectionChange } =
    createRowSelectionHelpers(selection, setSelection);
  /** Returns binding rows targeted by row markers, active cells, or cell ranges. */
  const selectedRows = (): number[] =>
    getEditTargetRowIndices(selection(), displayRows().length);

  const rows = createMemo<BindingRow[]>(() => {
    const snapshot = $bindings();
    const fixtureMap = $fixtures();
    const rows: BindingRow[] = [];

    (snapshot.input ?? []).forEach((binding, index) => {
      rows.push(toInputBindingRow(binding, fixtureMap, `input-${index}`));
    });

    (snapshot.output ?? []).forEach((binding, index) => {
      rows.push(toOutputBindingRow(binding, fixtureMap, `output-${index}`));
    });

    (snapshot.disabled ?? []).forEach((binding, index) => {
      rows.push(toDisabledBindingRow(binding, fixtureMap, `disabled-${index}`));
    });

    return rows;
  });
  const filterColumns = createMemo(() =>
    filterColumnsFromMetadata(DEFAULT_COLUMNS),
  );
  const {
    filters: tableFilters,
    filteredRows: displayRows,
    setFilters: setTableFilters,
  } = createDataGridFilterState({
    scope: `${props.panelId}:bindings`,
    rows,
    columns: filterColumns,
    onFiltersChange: clearSelection,
  });

  const deleteSelectedBindings = () => {
    const rows = displayRows();
    const filters = selectedRows()
      .map((rowIndex) => rows[rowIndex]?.deleteFilter ?? null)
      .filter((filter): filter is BindingDeleteFilter => filter !== null);

    if (filters.length === 0) {
      clearSelection();
      return;
    }

    for (const filter of filters) {
      sendRemovePatchBinding(
        filter.source,
        filter.target,
        filter.priority,
        filter.clone,
      );
    }

    clearSelection();
  };

  createEffect(() => {
    props.onSelectionCountChange?.(selectedRows().length);
  });

  createEffect(() => {
    props.onDeleteActionChange?.(deleteSelectedBindings);
  });

  const bindingConflictColumns = createMemo(() => {
    const activeUniverses = $dmxUniverseData().map(
      (universe) => universe.universe_id,
    );
    const analysis = computeBindingOverlapAnalysis(
      $bindings(),
      activeUniverses,
    );
    return analysis.conflictColumnsByBinding;
  });

  /** Clears any pending or visible patch binding conflict tooltip. */
  const clearConflictTooltip = () => {
    if (conflictTooltipTimeoutId !== undefined) {
      clearTimeout(conflictTooltipTimeoutId);
      conflictTooltipTimeoutId = undefined;
    }
    setConflictTooltip(undefined);
  };

  /** Describes why a binding row carries a conflict warning glyph. */
  const conflictTooltipContentForRow = (row: BindingRow): string => {
    if (row.kind.startsWith("Input")) {
      return "This input binding overlaps another input route on at least one universe/address.";
    }
    if (row.kind.startsWith("Output")) {
      return "This output binding overlaps another output route on at least one universe/address.";
    }
    return "This binding overlaps another binding on at least one universe/address.";
  };

  /** Returns the conflict tooltip content for one grid cell, when applicable. */
  const conflictTooltipContentForCell = (cell: Item): string | undefined => {
    const [col, row] = cell;
    const rowData = displayRows()[row];
    const columnId = String(displayColumns()[col]?.id);
    if (
      !isBindingConflictColumn(columnId) ||
      !rowData ||
      !bindingConflictColumns().get(rowData.id)?.has(columnId)
    ) {
      return undefined;
    }
    return conflictTooltipContentForRow(rowData);
  };

  /** Schedules a delayed tooltip for conflicted binding value cells. */
  const onCellHovered = (cell: Item | undefined, element?: HTMLElement) => {
    clearConflictTooltip();
    if (!cell || !element) return;

    const content = conflictTooltipContentForCell(cell);
    if (!content) return;

    conflictTooltipTimeoutId = setTimeout(() => {
      setConflictTooltip({
        id: ++conflictTooltipId,
        content,
        anchorRect: element.getBoundingClientRect(),
      });
      conflictTooltipTimeoutId = undefined;
    }, 500);
  };

  createEffect(() => {
    const navigateRequest = props.navigateToBinding;
    if (!navigateRequest) {
      return;
    }

    const rowIndex = displayRows().findIndex(
      (row) => row.id === navigateRequest.bindingId,
    );
    if (rowIndex < 0) {
      props.onNavigateHandled?.(navigateRequest.requestId);
      return;
    }

    setSelection({
      columns: CompactSelection.empty(),
      rows: CompactSelection.fromSingleSelection(rowIndex),
      current: {
        cell: [0, rowIndex],
        range: {
          x: 0,
          y: rowIndex,
          width: 1,
          height: 1,
        },
        rangeStack: [],
      },
    });

    props.onNavigateHandled?.(navigateRequest.requestId);
  });

  onCleanup(() => {
    clearConflictTooltip();
    props.onSelectionCountChange?.(0);
    props.onDeleteActionChange?.(null);
    props.onColumnVisibilityControlChange?.(null);
  });

  createEffect(() => {
    props.onColumnVisibilityControlChange?.(
      <>
        <DataGridFilterMenu
          columns={filterColumns()}
          filters={tableFilters()}
          visibleRows={displayRows().length}
          totalRows={rows().length}
          onFiltersChange={setTableFilters}
        />
        <ColumnVisibilityMenu scope={props.panelId} columns={columns()} />
      </>,
    );
  });

  const cellProvider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: displayRows(),
      columns: displayColumns(),
      rowKey: (row) => row.id,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: item, column }): GridCell => {
        const colId = column.id;
        switch (colId) {
          case "type":
            return makeSafeTextCell(item.kind);
          case "source":
            return {
              ...makeSafeTextCell(item.source),
              themeOverride: bindingConflictColumns()
                .get(item.id)
                ?.has("source")
                ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                : undefined,
            };
          case "target":
            return {
              ...makeSafeTextCell(item.target),
              themeOverride: bindingConflictColumns()
                .get(item.id)
                ?.has("target")
                ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                : undefined,
            };
          case "priority":
            return {
              kind: GridCellKind.Number,
              data: item.priority,
              displayData: String(item.priority),
              allowOverlay: false,
            };
          case "clone":
            return {
              kind: GridCellKind.Boolean,
              data: item.clone,
              allowOverlay: false,
            };
          default:
            return makeSafeTextCell("");
        }
      },
    }),
  );

  /** Draws conflict warning glyphs for patch binding rows. */
  const conflictCellDecorations = createMemo(() => {
    const columns = displayColumns();
    const rows = displayRows();
    const drawDecorations: DataGridCellDecorationCallback = (args) => {
      const row = rows[args.row];
      const columnId = String(columns[args.col]?.id);
      if (!row || !isBindingConflictColumn(columnId)) return;
      if (!bindingConflictColumns().get(row.id)?.has(columnId)) return;

      drawConflictWarningIcon(args);
    };

    return drawDecorations;
  });

  /** Tracks patch binding conflicts that require decoration canvas redraws. */
  const conflictDecorationInvalidateKey = createMemo(() =>
    Array.from(bindingConflictColumns())
      .flatMap(([rowId, columns]) =>
        Array.from(columns).map((column) => `${rowId}:${column}`),
      )
      .sort()
      .join("|"),
  );

  return (
    <div class="relative h-full w-full">
      <Show
        when={displayRows().length > 0}
        fallback={
          <div class="h-full p-4 text-center text-gray-500 text-sm">
            No bindings. Use patch commands or the wizard to create fixture
            patches.
          </div>
        }
      >
        <DataGrid
          rows={displayRows().length}
          columns={displayColumns()}
          cellProvider={cellProvider}
          rowHeight={30}
          rowMarkers="checkbox"
          gridSelection={selection()}
          onGridSelectionChange={handleGridSelectionChange}
          cellDecorations={conflictCellDecorations()}
          decorationInvalidateKey={conflictDecorationInvalidateKey()}
          onCellHovered={onCellHovered}
          width="100%"
          height="100%"
          freezeColumns={1}
          onColumnResize={(column, newSize) => {
            setColumns((prev) =>
              prev.map((c) =>
                c.id === column.id ? { ...c, width: newSize } : c,
              ),
            );
          }}
        />
        <Tooltip
          content={() => conflictTooltip()?.content ?? ""}
          position="bottom"
          anchorRect={() => conflictTooltip()?.anchorRect}
          animationKey={() => conflictTooltip()?.id}
          forceVisible={() => conflictTooltip() !== undefined}
        >
          <span aria-hidden="true" />
        </Tooltip>
      </Show>
    </div>
  );
}
