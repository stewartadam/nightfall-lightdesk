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
import { sendRemoveDmxRoutes } from "../../../lib/fixture-service";
import { computeRouteOverlapAnalysis } from "../../../lib/route-overlap";
import { useSharedStore } from "../../../lib/use-shared-store";
import { dmxUniverseList, fixtures, routes } from "../../../state/appStores";
import {
  type ConflictTooltipState,
  DEFAULT_COLUMNS,
  isRouteConflictColumn,
  type RouteDeleteFilter,
  type RouteRow,
  toDisabledRouteRow,
  toInputRouteRow,
  toOutputRouteRow,
} from "../model/routes-model";

export interface DmxRoutesTabProps {
  panelId: string;
  onSelectionCountChange?: (count: number) => void;
  onDeleteActionChange?: (action: (() => void) | null) => void;
  navigateToRoute?: { routeId: string; requestId: number } | null;
  onNavigateHandled?: (requestId: number) => void;
  onColumnVisibilityControlChange?: (control: JSX.Element | null) => void;
}

export default function DmxRoutesTab(props: DmxRoutesTabProps) {
  const $routes = useStore(routes);
  const $fixtures = useSharedStore(fixtures);
  const $dmxUniverseList = useStore(dmxUniverseList);
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
  /** Returns route rows targeted by row markers, active cells, or cell ranges. */
  const selectedRows = (): number[] =>
    getEditTargetRowIndices(selection(), displayRows().length);

  const rows = createMemo<RouteRow[]>(() => {
    const snapshot = $routes();
    const fixtureMap = $fixtures();
    const rows: RouteRow[] = [];

    (snapshot.input ?? []).forEach((route, index) => {
      rows.push(toInputRouteRow(route, fixtureMap, `input-${index}`));
    });

    (snapshot.output ?? []).forEach((route, index) => {
      rows.push(toOutputRouteRow(route, fixtureMap, `output-${index}`));
    });

    (snapshot.disabled ?? []).forEach((route, index) => {
      rows.push(toDisabledRouteRow(route, fixtureMap, `disabled-${index}`));
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
    scope: `${props.panelId}:routes`,
    rows,
    columns: filterColumns,
    onFiltersChange: clearSelection,
  });

  const deleteSelectedRoutes = () => {
    const rows = displayRows();
    const filters = selectedRows()
      .map((rowIndex) => rows[rowIndex]?.deleteFilter ?? null)
      .filter((filter): filter is RouteDeleteFilter => filter !== null);

    if (filters.length === 0) {
      clearSelection();
      return;
    }

    for (const filter of filters) {
      sendRemoveDmxRoutes(
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
    props.onDeleteActionChange?.(deleteSelectedRoutes);
  });

  const routeConflictColumns = createMemo(() => {
    const activeUniverses = $dmxUniverseList().map(
      (universe) => universe.universe_id,
    );
    const analysis = computeRouteOverlapAnalysis($routes(), activeUniverses);
    return analysis.conflictColumnsByRoute;
  });

  /** Clears any pending or visible DMX route conflict tooltip. */
  const clearConflictTooltip = () => {
    if (conflictTooltipTimeoutId !== undefined) {
      clearTimeout(conflictTooltipTimeoutId);
      conflictTooltipTimeoutId = undefined;
    }
    setConflictTooltip(undefined);
  };

  /** Describes why a route row carries a conflict warning glyph. */
  const conflictTooltipContentForRow = (row: RouteRow): string => {
    if (row.kind.startsWith("Input")) {
      return "This input route overlaps another input route on at least one universe/address.";
    }
    if (row.kind.startsWith("Output")) {
      return "This output route overlaps another output route on at least one universe/address.";
    }
    return "This route overlaps another route on at least one universe/address.";
  };

  /** Returns the conflict tooltip content for one grid cell, when applicable. */
  const conflictTooltipContentForCell = (cell: Item): string | undefined => {
    const [col, row] = cell;
    const rowData = displayRows()[row];
    const columnId = String(displayColumns()[col]?.id);
    if (
      !isRouteConflictColumn(columnId) ||
      !rowData ||
      !routeConflictColumns().get(rowData.id)?.has(columnId)
    ) {
      return undefined;
    }
    return conflictTooltipContentForRow(rowData);
  };

  /** Schedules a delayed tooltip for conflicted route value cells. */
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
    const navigateRequest = props.navigateToRoute;
    if (!navigateRequest) {
      return;
    }

    const rowIndex = displayRows().findIndex(
      (row) => row.id === navigateRequest.routeId,
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
              themeOverride: routeConflictColumns().get(item.id)?.has("source")
                ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                : undefined,
            };
          case "target":
            return {
              ...makeSafeTextCell(item.target),
              themeOverride: routeConflictColumns().get(item.id)?.has("target")
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

  /** Draws conflict warning glyphs for DMX route rows. */
  const conflictCellDecorations = createMemo(() => {
    const columns = displayColumns();
    const rows = displayRows();
    const drawDecorations: DataGridCellDecorationCallback = (args) => {
      const row = rows[args.row];
      const columnId = String(columns[args.col]?.id);
      if (!row || !isRouteConflictColumn(columnId)) return;
      if (!routeConflictColumns().get(row.id)?.has(columnId)) return;

      drawConflictWarningIcon(args);
    };

    return drawDecorations;
  });

  /** Tracks DMX route conflicts that require decoration canvas redraws. */
  const conflictDecorationInvalidateKey = createMemo(() =>
    Array.from(routeConflictColumns())
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
            No routes. Use patch commands or the wizard to create fixture
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
          class="absolute top-0 left-0"
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
