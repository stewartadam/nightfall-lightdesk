// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import {
  type ContextMenuEntry,
  openContextMenu,
} from "../../../components/providers/context-menu";
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
  CellClickedEventArgs,
  GridCell,
  Item,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  applyElementBackground,
  CONFLICT_VALUE_TEXT_COLOR,
  makeSafeTextCell,
} from "../../../lib/datagrid";
import {
  filterVisibleColumns,
  type VisibilityGridColumn,
} from "../../../lib/datagrid-column-visibility";
import { filterColumnsFromMetadata } from "../../../lib/datagrid-filtering";
import { getRouteIdForAltFollow } from "../../../lib/route-follow";
import {
  computeRouteOverlapAnalysis,
  type RouteConflictColumn,
  type UniverseKey,
} from "../../../lib/route-overlap";
import { useSharedStore } from "../../../lib/use-shared-store";
import { dmxUniverseList, fixtures, routes } from "../../../state/appStores";
import {
  type RouteRow,
  toDisabledRouteRow,
  toInputRouteRow,
  toOutputRouteRow,
} from "../model/routes-model";
import {
  type ConflictTooltipState,
  collectUniversesFromInputSource,
  collectUniversesFromInputTarget,
  collectUniversesFromOutputSource,
  collectUniversesFromOutputTarget,
  DEFAULT_COLUMNS,
  formatGroupWithChevron,
  formatUniverseLabel,
  type UniverseDisplayRow,
  type UniverseGroupRow,
  type UniverseRouteRow,
  universeDisplayCellHasConflict,
} from "../model/universes-model";

export interface PatchUniversesTabProps {
  panelId: string;
  onNavigateToRoute?: (routeId: string) => void;
  onColumnVisibilityControlChange?: (control: JSX.Element | null) => void;
}

export default function PatchUniversesTab(props: PatchUniversesTabProps) {
  const $routes = useStore(routes);
  const $fixtures = useSharedStore(fixtures);
  const $dmxUniverseList = useStore(dmxUniverseList);

  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [columns, setColumns] =
    createSignal<VisibilityGridColumn[]>(DEFAULT_COLUMNS);
  const [conflictTooltip, setConflictTooltip] =
    createSignal<ConflictTooltipState>();
  let conflictTooltipTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let conflictTooltipId = 0;
  const displayColumns = createMemo(() => {
    return filterVisibleColumns(columns(), props.panelId);
  });

  const universeGroups = createMemo(() => {
    const snapshot = $routes();
    const fixtureMap = $fixtures();
    const activeUniverses = $dmxUniverseList().map(
      (universe) => universe.universe_id,
    );
    const overlapAnalysis = computeRouteOverlapAnalysis(
      snapshot,
      activeUniverses,
    );
    const universeIds = new Set<number>(overlapAnalysis.universeIds);

    const byUniverse = new Map<UniverseKey, RouteRow[]>();

    const ensure = (key: UniverseKey) => {
      if (!byUniverse.has(key)) byUniverse.set(key, []);
      return byUniverse.get(key)!;
    };
    const overlapsByUniverse = overlapAnalysis.overlapByUniverse;

    const addToUniverses = (keys: Set<UniverseKey>, row: RouteRow) => {
      const specificUniverses = [...keys].filter((k) => k !== "*");
      if (specificUniverses.length > 0) {
        for (const key of specificUniverses) {
          ensure(key).push(row);
        }
        return;
      }

      if (keys.has("*")) {
        ensure("*").push(row);
        for (const u of universeIds) {
          ensure(u).push(row);
        }
        return;
      }

      for (const key of keys) {
        ensure(key).push(row);
      }
    };

    snapshot.input.forEach((route, index) => {
      const keys = new Set<UniverseKey>([
        ...collectUniversesFromInputSource(route.source),
        ...collectUniversesFromInputTarget(route.target),
      ]);

      addToUniverses(
        keys,
        toInputRouteRow(route, fixtureMap, `input-${index}`),
      );
    });

    snapshot.output.forEach((route, index) => {
      const keys = new Set<UniverseKey>([
        ...collectUniversesFromOutputSource(route.source),
        ...collectUniversesFromOutputTarget(route.target),
      ]);

      addToUniverses(
        keys,
        toOutputRouteRow(route, fixtureMap, `output-${index}`),
      );
    });

    snapshot.disabled.forEach((route, index) => {
      const keys = new Set<UniverseKey>(
        collectUniversesFromInputSource(route.data.source),
      );

      addToUniverses(
        keys,
        toDisabledRouteRow(route, fixtureMap, `disabled-${index}`),
      );
    });

    for (const u of universeIds) {
      if (!byUniverse.has(u)) byUniverse.set(u, []);
    }

    const keys: UniverseKey[] = Array.from(byUniverse.keys());
    keys.sort((a, b) => {
      if (a === "*" && b === "*") return 0;
      if (a === "*") return -1;
      if (b === "*") return 1;
      return a - b;
    });

    return {
      keys,
      byUniverse,
      overlapsByUniverse,
      conflictColumnsByRoute: overlapAnalysis.conflictColumnsByRoute,
    };
  });

  const rows = createMemo<UniverseDisplayRow[]>(() => {
    const { keys, byUniverse, overlapsByUniverse, conflictColumnsByRoute } =
      universeGroups();
    const exp = expanded();
    const rows: UniverseDisplayRow[] = [];

    for (const key of keys) {
      const routesForUniverse = byUniverse.get(key) ?? [];
      const isExpanded = exp.has(String(key));

      const routeCounts = routesForUniverse.reduce(
        (acc, row) => {
          if (row.kind.startsWith("Input")) acc.input += 1;
          else if (row.kind.startsWith("Output")) acc.output += 1;
          else if (row.kind.startsWith("Disabled")) acc.disabled += 1;
          return acc;
        },
        { input: 0, output: 0, disabled: 0 },
      );

      const overlapFlags = overlapsByUniverse.get(key) ?? {
        inputOverlap: false,
        outputOverlap: false,
      };

      rows.push({
        rowKind: "universe",
        universe: key,
        routeCounts,
        inputOverlap: overlapFlags.inputOverlap,
        outputOverlap: overlapFlags.outputOverlap,
        isExpanded,
      });

      if (isExpanded) {
        const sorted = [...routesForUniverse].sort(
          (a, b) => a.priority - b.priority,
        );
        for (const route of sorted) {
          rows.push({
            rowKind: "route",
            universe: key,
            route,
            conflictColumns:
              conflictColumnsByRoute.get(route.id) ??
              new Set<RouteConflictColumn>(),
          });
        }
      }
    }

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
    scope: `${props.panelId}:routes-universe`,
    rows,
    columns: filterColumns,
  });

  /** Clears any pending or visible universe conflict tooltip. */
  const clearConflictTooltip = () => {
    if (conflictTooltipTimeoutId !== undefined) {
      clearTimeout(conflictTooltipTimeoutId);
      conflictTooltipTimeoutId = undefined;
    }
    setConflictTooltip(undefined);
  };

  /** Describes a universe summary conflict warning for the hovered column. */
  const universeConflictTooltipContent = (
    row: UniverseGroupRow,
    columnId: string,
  ): string | undefined => {
    const universeLabel = formatUniverseLabel(row.universe);
    if (columnId === "source" && row.inputOverlap) {
      return `${universeLabel} has overlapping input routes on at least one address.`;
    }
    if (columnId === "target" && row.outputOverlap) {
      return `${universeLabel} has overlapping output routes on at least one address.`;
    }
    return undefined;
  };

  /** Describes an individual route conflict warning in a universe row. */
  const routeConflictTooltipContent = (
    row: UniverseRouteRow,
    columnId: string,
  ): string | undefined => {
    if (
      (columnId !== "source" && columnId !== "target") ||
      !row.conflictColumns.has(columnId)
    ) {
      return undefined;
    }
    const universeLabel = formatUniverseLabel(row.universe);
    if (row.route.kind.startsWith("Input")) {
      return `This input route overlaps another input route in ${universeLabel}.`;
    }
    if (row.route.kind.startsWith("Output")) {
      return `This output route overlaps another output route in ${universeLabel}.`;
    }
    return `This route overlaps another route in ${universeLabel}.`;
  };

  /** Returns the conflict tooltip content for one grid cell, when applicable. */
  const conflictTooltipContentForCell = (cell: Item): string | undefined => {
    const [col, row] = cell;
    const rowData = displayRows()[row];
    const columnId = displayColumns()[col]?.id;
    if (!rowData || typeof columnId !== "string") return undefined;
    if (rowData.rowKind === "universe") {
      return universeConflictTooltipContent(rowData, columnId);
    }
    return routeConflictTooltipContent(rowData, columnId);
  };

  /** Schedules a delayed tooltip for conflicted universe cells. */
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

  const cellProvider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: displayRows(),
      columns: displayColumns(),
      rowKey: (row) =>
        row.rowKind === "universe"
          ? `universe:${String(row.universe)}`
          : `route:${String(row.universe)}:${row.route.id}`,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: item, column }): GridCell => {
        const colId = column.id;
        if (item.rowKind === "universe") {
          if (colId === "universe") {
            const label = formatUniverseLabel(item.universe);
            return {
              kind: GridCellKind.Text,
              data: label,
              displayData: formatGroupWithChevron(item.isExpanded, label),
              allowOverlay: false,
            };
          }
          if (colId === "type") {
            return {
              kind: GridCellKind.Text,
              data: "",
              displayData: item.routeCounts.disabled > 0 ? "Disabled" : "",
              allowOverlay: false,
              themeOverride: { textDark: "#b8b8b8" },
            };
          }
          if (colId === "source") {
            return {
              kind: GridCellKind.Text,
              data: "",
              displayData: `In - ${item.routeCounts.input}`,
              allowOverlay: false,
              themeOverride: {
                textDark: item.inputOverlap
                  ? CONFLICT_VALUE_TEXT_COLOR
                  : "#b8b8b8",
              },
            };
          }
          if (colId === "target") {
            return {
              kind: GridCellKind.Text,
              data: "",
              displayData: `DMX - ${item.routeCounts.output}`,
              allowOverlay: false,
              themeOverride: {
                textDark: item.outputOverlap
                  ? CONFLICT_VALUE_TEXT_COLOR
                  : "#b8b8b8",
              },
            };
          }
          return makeSafeTextCell("");
        }

        const route = item.route;
        const isChild = true;

        let cell: GridCell;
        switch (colId) {
          case "universe":
            cell = makeSafeTextCell("");
            break;
          case "type":
            cell = makeSafeTextCell(route.kind);
            break;
          case "source":
            cell = {
              ...makeSafeTextCell(route.source),
              themeOverride: item.conflictColumns.has("source")
                ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                : undefined,
            };
            break;
          case "target":
            cell = {
              ...makeSafeTextCell(route.target),
              themeOverride: item.conflictColumns.has("target")
                ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                : undefined,
            };
            break;
          case "priority":
            cell = {
              kind: GridCellKind.Number,
              data: route.priority,
              displayData: String(route.priority),
              allowOverlay: false,
            };
            break;
          case "clone":
            cell = {
              kind: GridCellKind.Boolean,
              data: route.clone,
              allowOverlay: false,
            };
            break;
          default:
            cell = makeSafeTextCell("");
            break;
        }

        return applyElementBackground(cell, isChild);
      },
    }),
  );

  /** Draws conflict warning glyphs for universe summary and route rows. */
  const conflictCellDecorations = createMemo(() => {
    const columns = displayColumns();
    const rows = displayRows();
    const drawDecorations: DataGridCellDecorationCallback = (args) => {
      const row = rows[args.row];
      if (!row) return;

      if (universeDisplayCellHasConflict(row, String(columns[args.col]?.id))) {
        drawConflictWarningIcon(args);
      }
    };

    return drawDecorations;
  });

  /** Tracks universe conflicts that require decoration canvas redraws. */
  const conflictDecorationInvalidateKey = createMemo(() =>
    displayRows()
      .flatMap((row) => {
        if (row.rowKind === "route") {
          return Array.from(row.conflictColumns).map(
            (column) => `${String(row.universe)}:${row.route.id}:${column}`,
          );
        }

        return [
          row.inputOverlap ? `${String(row.universe)}:source` : undefined,
          row.outputOverlap ? `${String(row.universe)}:target` : undefined,
        ].filter((key): key is string => key !== undefined);
      })
      .join("|"),
  );

  /** Navigates from a grouped universe row to its route detail row. */
  const navigateToRouteRow = (rowData: UniverseDisplayRow): boolean => {
    const routeId = getRouteIdForAltFollow(rowData, true);
    if (!routeId || !props.onNavigateToRoute) {
      return false;
    }

    props.onNavigateToRoute(routeId);
    return true;
  };

  /** Handles grouped universe clicks for expansion and shortcut navigation. */
  const handleCellClicked = (cell: Item, event: CellClickedEventArgs) => {
    const [col, row] = cell;
    const rowData = displayRows()[row];
    if (!rowData) return;
    const altKey = (event as CellClickedEventArgs & { altKey?: boolean })
      .altKey;

    if (altKey === true && navigateToRouteRow(rowData)) {
      return;
    }

    const colId = displayColumns()[col]?.id;
    if (colId !== "universe") return;
    if (rowData.rowKind !== "universe") return;

    setExpanded((prev) => {
      const next = new Set(prev);
      const key = String(rowData.universe);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  /** Opens right-click affordances for grouped universe route rows. */
  const handleCellContextMenu = (cell: Item, event: MouseEvent) => {
    const [, row] = cell;
    const rowData = displayRows()[row];
    if (rowData?.rowKind !== "route") {
      return;
    }

    event.preventDefault();
    const items: ContextMenuEntry[] = [
      {
        id: "show-route",
        label: "Show route",
        icon: ArrowsClockwiseIcon,
        shortcut: "Alt+Click",
        disabled: props.onNavigateToRoute === undefined,
        onSelect: () => navigateToRouteRow(rowData),
      },
    ];
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items,
    });
  };

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

  onCleanup(() => {
    clearConflictTooltip();
    props.onColumnVisibilityControlChange?.(null);
  });

  return (
    <div class="relative h-full w-full">
      <Show
        when={displayRows().length > 0}
        fallback={<div class="p-4 text-gray-500">No universe data</div>}
      >
        <DataGrid
          rows={displayRows().length}
          columns={displayColumns()}
          cellProvider={cellProvider}
          rowHeight={30}
          width="100%"
          height="100%"
          freezeColumns={1}
          onCellClicked={handleCellClicked}
          onCellContextMenu={handleCellContextMenu}
          cellDecorations={conflictCellDecorations()}
          decorationInvalidateKey={conflictDecorationInvalidateKey()}
          onCellHovered={onCellHovered}
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
