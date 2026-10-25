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
import { EmptyState } from "../../../components/ui/empty-state";
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
  alwaysVisibleColumnMeta,
  columnVisibilityMeta,
  filterVisibleColumns,
  type VisibilityGridColumn,
} from "../../../lib/datagrid-column-visibility";
import {
  type FilterableGridColumn,
  filterColumnsFromMetadata,
} from "../../../lib/datagrid-filtering";
import { getRouteIdForAltFollow } from "../../../lib/route-follow";
import {
  computeRouteOverlapAnalysis,
  type RouteConflictColumn,
} from "../../../lib/route-overlap";
import { useSharedStore } from "../../../lib/use-shared-store";
import { dmxUniverseList, fixtures, routes } from "../../../state/appStores";
import {
  type ConflictTooltipState,
  DISABLED_TEXT_COLOR,
  disabledRouteTouchesFixture,
  type FixtureDisplayRow,
  fixtureDisplayCellHasConflict,
  fixtureOutputOccupancyKey,
  fixtureUidsFromInputSource,
  fixtureUidsFromInputTarget,
  formatFixtureGroupLabel,
  formatGroupWithChevron,
  inputRouteTouchesFixture,
  outputRouteTouchesFixture,
} from "../model/fixtures-model";
import {
  type RouteRow,
  toDisabledRouteRow,
  toInputRouteRow,
  toOutputRouteRow,
} from "../model/routes-model";

export interface PatchFixturesTabProps {
  panelId: string;
  onNavigateToRoute?: (routeId: string) => void;
  onColumnVisibilityControlChange?: (control: JSX.Element | null) => void;
}

export default function PatchFixturesTab(props: PatchFixturesTabProps) {
  const $routes = useStore(routes);
  const $fixtures = useSharedStore(fixtures);
  const $dmxUniverseList = useStore(dmxUniverseList);

  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [conflictTooltip, setConflictTooltip] =
    createSignal<ConflictTooltipState>();
  let conflictTooltipTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let conflictTooltipId = 0;
  const [columns, setColumns] = createSignal<
    FilterableGridColumn<FixtureDisplayRow, VisibilityGridColumn>[]
  >([
    {
      title: "Fixture",
      id: "fixture",
      width: 260,
      filter: {
        value: (row) =>
          row.rowKind === "fixture" ? row.fixtureLabel : row.fixtureUid,
      },
      ...alwaysVisibleColumnMeta("Identity", "Fixture"),
    },
    {
      title: "Type",
      id: "type",
      width: 140,
      filter: {
        value: (row) =>
          row.rowKind === "fixture"
            ? row.disabled
              ? "Disabled"
              : ""
            : row.route.kind,
      },
      ...columnVisibilityMeta("Route", "Type"),
    },
    {
      title: "Source",
      id: "source",
      width: 220,
      filter: {
        value: (row) =>
          row.rowKind === "fixture"
            ? `In ${row.routeCounts.input}`
            : row.route.source,
      },
      ...columnVisibilityMeta("Route", "Source"),
    },
    {
      title: "Target",
      id: "target",
      width: 220,
      filter: {
        value: (row) =>
          row.rowKind === "fixture"
            ? `DMX ${row.routeCounts.output}`
            : row.route.target,
      },
      ...columnVisibilityMeta("Route", "Target"),
    },
    {
      title: "Priority",
      id: "priority",
      width: 90,
      filter: {
        kind: "number",
        value: (row) => (row.rowKind === "route" ? row.route.priority : null),
      },
      ...columnVisibilityMeta("Route", "Priority"),
    },
    {
      title: "Clone",
      id: "clone",
      width: 70,
      filter: {
        kind: "boolean",
        value: (row) => row.rowKind === "route" && row.route.clone,
      },
      ...columnVisibilityMeta("Route", "Clone"),
    },
  ]);
  const displayColumns = createMemo(() => {
    return filterVisibleColumns(columns(), props.panelId);
  });

  const rows = createMemo<FixtureDisplayRow[]>(() => {
    const snapshot = $routes();
    const fixtureMap = $fixtures();
    const activeUniverses = $dmxUniverseList().map(
      (universe) => universe.universe_id,
    );
    const conflictColumnsByRoute = computeRouteOverlapAnalysis(
      snapshot,
      activeUniverses,
    ).conflictColumnsByRoute;
    const exp = expanded();

    const rows: FixtureDisplayRow[] = [];

    const fixtureUids = Object.keys(fixtureMap).sort((a, b) => {
      const fa = fixtureMap[a];
      const fb = fixtureMap[b];
      if (!fa || !fb) return a.localeCompare(b);
      return fa.identifiers.id - fb.identifiers.id;
    });

    for (const uid of fixtureUids) {
      const fixture = fixtureMap[uid];
      if (!fixture) continue;

      const inputRows: RouteRow[] = [];
      const outputRows: RouteRow[] = [];
      const disabledRows: RouteRow[] = [];
      let disabledByRoute = false;
      let inputOverlap = false;
      let outputOverlap = false;
      const seenInputTargets = new Set<string>();
      const seenOutputTargets = new Set<string>();

      snapshot.input.forEach((route, index) => {
        if (!inputRouteTouchesFixture(route, uid)) return;
        if (
          route.source.type === "Fixture" &&
          route.target.type === "Disabled" &&
          fixtureUidsFromInputSource(route.source).has(uid)
        ) {
          disabledByRoute = true;
        }
        if (
          route.target.type === "Fixture" &&
          fixtureUidsFromInputTarget(route.target).has(uid)
        ) {
          const elementKey = route.target.data.element ?? "*";
          const paramKey = route.target.data.param ?? "*";
          const targetKey = `${uid}:${elementKey}:${paramKey}`;
          if (seenInputTargets.has(targetKey)) inputOverlap = true;
          seenInputTargets.add(targetKey);
        }
        inputRows.push(toInputRouteRow(route, fixtureMap, `input-${index}`));
      });

      snapshot.output.forEach((route, index) => {
        if (!outputRouteTouchesFixture(route, uid)) return;
        const key = fixtureOutputOccupancyKey(route, uid);
        if (key) {
          if (seenOutputTargets.has(key)) outputOverlap = true;
          seenOutputTargets.add(key);
        }
        outputRows.push(toOutputRouteRow(route, fixtureMap, `output-${index}`));
      });

      snapshot.disabled.forEach((route, index) => {
        if (!disabledRouteTouchesFixture(route, uid)) return;
        disabledByRoute = true;
        disabledRows.push(
          toDisabledRouteRow(route, fixtureMap, `disabled-${index}`),
        );
      });

      const routeRows = [...inputRows, ...outputRows, ...disabledRows].sort(
        (a, b) => a.priority - b.priority,
      );

      const counts = {
        input: inputRows.length,
        output: outputRows.length,
        disabled: disabledRows.length,
      };

      const isExpanded = exp.has(uid);

      rows.push({
        rowKind: "fixture",
        fixtureUid: uid,
        fixtureLabel: formatFixtureGroupLabel(fixture),
        disabled: disabledByRoute,
        routeCounts: counts,
        inputOverlap,
        outputOverlap,
        routeRows,
        isExpanded,
      });

      if (isExpanded) {
        for (const routeRow of routeRows) {
          rows.push({
            rowKind: "route",
            fixtureUid: uid,
            route: routeRow,
            conflictColumns:
              conflictColumnsByRoute.get(routeRow.id) ??
              new Set<RouteConflictColumn>(),
          });
        }
      }
    }

    return rows;
  });
  const filterColumns = createMemo(() => filterColumnsFromMetadata(columns()));
  const {
    filters: tableFilters,
    filteredRows: displayRows,
    setFilters: setTableFilters,
  } = createDataGridFilterState({
    scope: `${props.panelId}:routes-fixture`,
    rows,
    columns: filterColumns,
  });

  /** Clears any pending or visible fixture conflict tooltip. */
  const clearConflictTooltip = () => {
    if (conflictTooltipTimeoutId !== undefined) {
      clearTimeout(conflictTooltipTimeoutId);
      conflictTooltipTimeoutId = undefined;
    }
    setConflictTooltip(undefined);
  };

  /** Returns the conflict tooltip content for one fixture summary cell. */
  const conflictTooltipContentForCell = (cell: Item): string | undefined => {
    const [col, row] = cell;
    const rowData = displayRows()[row];
    const columnId = displayColumns()[col]?.id;
    if (!rowData || typeof columnId !== "string") return undefined;
    if (rowData.rowKind === "route") {
      if (
        (columnId !== "source" && columnId !== "target") ||
        !rowData.conflictColumns.has(columnId)
      ) {
        return undefined;
      }
      if (rowData.route.kind.startsWith("Input")) {
        return "This input route overlaps another input route.";
      }
      if (rowData.route.kind.startsWith("Output")) {
        return "This output route overlaps another output route.";
      }
      return "This route overlaps another route.";
    }

    if (columnId === "source" && rowData.inputOverlap) {
      return `${rowData.fixtureLabel} has overlapping input routes.`;
    }
    if (columnId === "target" && rowData.outputOverlap) {
      return `${rowData.fixtureLabel} has overlapping DMX output routes.`;
    }
    return undefined;
  };

  /** Schedules a delayed tooltip for conflicted fixture summary cells. */
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
        row.rowKind === "fixture"
          ? `fixture:${row.fixtureUid}`
          : `route:${row.fixtureUid}:${row.route.id}`,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: item, column }): GridCell => {
        const colId = column.id;
        if (item.rowKind === "fixture") {
          const themeOverride = item.disabled
            ? { textDark: DISABLED_TEXT_COLOR }
            : undefined;
          switch (colId) {
            case "fixture": {
              const label = item.fixtureLabel;
              return {
                kind: GridCellKind.Text,
                data: label,
                displayData: formatGroupWithChevron(item.isExpanded, label),
                allowOverlay: false,
                themeOverride,
              };
            }
            case "type":
              return {
                kind: GridCellKind.Text,
                data: "",
                displayData: item.disabled ? "⚠️ Disabled" : "",
                allowOverlay: false,
                themeOverride: item.disabled
                  ? { textDark: DISABLED_TEXT_COLOR }
                  : { textDark: "#b8b8b8" },
              };
            case "source":
              return {
                kind: GridCellKind.Text,
                data: "",
                displayData: `In - ${item.routeCounts.input}x`,
                allowOverlay: false,
                themeOverride:
                  themeOverride ??
                  (item.inputOverlap
                    ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                    : { textDark: "#b8b8b8" }),
              };
            case "target":
              return {
                kind: GridCellKind.Text,
                data: "",
                displayData: `DMX - ${item.routeCounts.output}x`,
                allowOverlay: false,
                themeOverride:
                  themeOverride ??
                  (item.outputOverlap
                    ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                    : { textDark: "#b8b8b8" }),
              };
            default:
              return {
                kind: GridCellKind.Text,
                data: "",
                displayData: "",
                allowOverlay: false,
                themeOverride,
              };
          }
        }

        const route = item.route;
        const isChild = item.rowKind === "route";

        let cell: GridCell;
        switch (colId) {
          case "fixture":
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

  /** Draws conflict warning glyphs for fixture summary rows. */
  const conflictCellDecorations = createMemo(() => {
    const columns = displayColumns();
    const rows = displayRows();
    const drawDecorations: DataGridCellDecorationCallback = (args) => {
      const row = rows[args.row];
      if (!row) return;

      if (fixtureDisplayCellHasConflict(row, String(columns[args.col]?.id))) {
        drawConflictWarningIcon(args);
      }
    };

    return drawDecorations;
  });

  /** Tracks fixture summary conflicts that require decoration canvas redraws. */
  const conflictDecorationInvalidateKey = createMemo(() =>
    displayRows()
      .flatMap((row) => {
        if (row.rowKind === "route") {
          return Array.from(row.conflictColumns).map(
            (column) => `${row.fixtureUid}:${row.route.id}:${column}`,
          );
        }

        return [
          row.inputOverlap ? `${row.fixtureUid}:source` : undefined,
          row.outputOverlap ? `${row.fixtureUid}:target` : undefined,
        ].filter((key): key is string => key !== undefined);
      })
      .join("|"),
  );

  /** Navigates from a grouped fixture row to its route detail row. */
  const navigateToRouteRow = (rowData: FixtureDisplayRow): boolean => {
    const routeId = getRouteIdForAltFollow(rowData, true);
    if (!routeId || !props.onNavigateToRoute) {
      return false;
    }

    props.onNavigateToRoute(routeId);
    return true;
  };

  /** Handles grouped fixture clicks for expansion and shortcut navigation. */
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
    if (colId !== "fixture") return;
    if (rowData.rowKind !== "fixture") return;

    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowData.fixtureUid)) {
        next.delete(rowData.fixtureUid);
      } else {
        next.add(rowData.fixtureUid);
      }
      return next;
    });
  };

  /** Opens right-click affordances for grouped fixture route rows. */
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
        when={Object.keys($fixtures()).length > 0}
        fallback={<EmptyState loading title="Loading fixtures..." />}
      >
        <DataGrid
          rows={displayRows().length}
          columns={displayColumns()}
          cellProvider={cellProvider}
          rowHeight={30}
          width="100%"
          height="100%"
          freezeColumns={1}
          cellDecorations={conflictCellDecorations()}
          decorationInvalidateKey={conflictDecorationInvalidateKey()}
          onCellClicked={handleCellClicked}
          onCellContextMenu={handleCellContextMenu}
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
