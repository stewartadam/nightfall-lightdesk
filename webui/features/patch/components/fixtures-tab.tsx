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
import { getBindingIdForAltFollow } from "../../../lib/binding-follow";
import {
  type BindingConflictColumn,
  computeBindingOverlapAnalysis,
} from "../../../lib/binding-overlap";
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
import { bindings, dmxUniverseData, fixtures } from "../../../state/appStores";
import {
  type BindingRow,
  toDisabledBindingRow,
  toInputBindingRow,
  toOutputBindingRow,
} from "../model/bindings-model";
import {
  type ConflictTooltipState,
  DISABLED_TEXT_COLOR,
  disabledBindingTouchesFixture,
  type FixtureDisplayRow,
  fixtureDisplayCellHasConflict,
  fixtureUidsFromInputSource,
  fixtureUidsFromInputTarget,
  fixtureUidsFromOutputSource,
  formatFixtureGroupLabel,
  formatGroupWithChevron,
  inputBindingTouchesFixture,
  outputBindingTouchesFixture,
  stableOutputTargetKey,
} from "../model/fixtures-model";

export interface PatchFixturesTabProps {
  panelId: string;
  onNavigateToBinding?: (bindingId: string) => void;
  onColumnVisibilityControlChange?: (control: JSX.Element | null) => void;
}

export default function PatchFixturesTab(props: PatchFixturesTabProps) {
  const $bindings = useStore(bindings);
  const $fixtures = useStore(fixtures);
  const $dmxUniverseData = useStore(dmxUniverseData);

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
            : row.binding.kind,
      },
      ...columnVisibilityMeta("Binding", "Type"),
    },
    {
      title: "Source",
      id: "source",
      width: 220,
      filter: {
        value: (row) =>
          row.rowKind === "fixture"
            ? `In ${row.bindingCounts.input}`
            : row.binding.source,
      },
      ...columnVisibilityMeta("Binding", "Source"),
    },
    {
      title: "Target",
      id: "target",
      width: 220,
      filter: {
        value: (row) =>
          row.rowKind === "fixture"
            ? `DMX ${row.bindingCounts.output}`
            : row.binding.target,
      },
      ...columnVisibilityMeta("Binding", "Target"),
    },
    {
      title: "Priority",
      id: "priority",
      width: 90,
      filter: {
        kind: "number",
        value: (row) =>
          row.rowKind === "binding" ? row.binding.priority : null,
      },
      ...columnVisibilityMeta("Binding", "Priority"),
    },
    {
      title: "Clone",
      id: "clone",
      width: 70,
      filter: {
        kind: "boolean",
        value: (row) => row.rowKind === "binding" && row.binding.clone,
      },
      ...columnVisibilityMeta("Binding", "Clone"),
    },
  ]);
  const displayColumns = createMemo(() => {
    return filterVisibleColumns(columns(), props.panelId);
  });

  const rows = createMemo<FixtureDisplayRow[]>(() => {
    const snapshot = $bindings();
    const fixtureMap = $fixtures();
    const activeUniverses = $dmxUniverseData().map(
      (universe) => universe.universe_id,
    );
    const conflictColumnsByBinding = computeBindingOverlapAnalysis(
      snapshot,
      activeUniverses,
    ).conflictColumnsByBinding;
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

      const inputRows: BindingRow[] = [];
      const outputRows: BindingRow[] = [];
      const disabledRows: BindingRow[] = [];
      let disabledByBinding = false;
      let inputOverlap = false;
      let outputOverlap = false;
      const seenInputTargets = new Set<string>();
      const seenOutputTargets = new Set<string>();

      snapshot.input.forEach((binding, index) => {
        if (!inputBindingTouchesFixture(binding, uid)) return;
        if (
          binding.source.type === "Fixture" &&
          binding.target.type === "Disabled" &&
          fixtureUidsFromInputSource(binding.source).has(uid)
        ) {
          disabledByBinding = true;
        }
        if (
          binding.target.type === "Fixture" &&
          fixtureUidsFromInputTarget(binding.target).has(uid)
        ) {
          const elementKey = binding.target.data.element ?? "*";
          const paramKey = binding.target.data.param ?? "*";
          const targetKey = `${uid}:${elementKey}:${paramKey}`;
          if (seenInputTargets.has(targetKey)) inputOverlap = true;
          seenInputTargets.add(targetKey);
        }
        inputRows.push(
          toInputBindingRow(binding, fixtureMap, `input-${index}`),
        );
      });

      snapshot.output.forEach((binding, index) => {
        if (!outputBindingTouchesFixture(binding, uid)) return;
        if (binding.target.type === "Disabled") {
          disabledByBinding = true;
        }
        if (
          binding.source.type === "Fixture" &&
          fixtureUidsFromOutputSource(binding.source).has(uid)
        ) {
          const key = stableOutputTargetKey(binding.target);
          if (key) {
            if (seenOutputTargets.has(key)) outputOverlap = true;
            seenOutputTargets.add(key);
          }
        }
        outputRows.push(
          toOutputBindingRow(binding, fixtureMap, `output-${index}`),
        );
      });

      snapshot.disabled.forEach((binding, index) => {
        if (!disabledBindingTouchesFixture(binding, uid)) return;
        disabledByBinding = true;
        disabledRows.push(
          toDisabledBindingRow(binding, fixtureMap, `disabled-${index}`),
        );
      });

      const bindingRows = [...inputRows, ...outputRows, ...disabledRows].sort(
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
        disabled: disabledByBinding,
        bindingCounts: counts,
        inputOverlap,
        outputOverlap,
        bindingRows,
        isExpanded,
      });

      if (isExpanded) {
        for (const bindingRow of bindingRows) {
          rows.push({
            rowKind: "binding",
            fixtureUid: uid,
            binding: bindingRow,
            conflictColumns:
              conflictColumnsByBinding.get(bindingRow.id) ??
              new Set<BindingConflictColumn>(),
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
    scope: `${props.panelId}:bindings-fixture`,
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
    if (rowData.rowKind === "binding") {
      if (
        (columnId !== "source" && columnId !== "target") ||
        !rowData.conflictColumns.has(columnId)
      ) {
        return undefined;
      }
      if (rowData.binding.kind.startsWith("Input")) {
        return "This input binding overlaps another input route.";
      }
      if (rowData.binding.kind.startsWith("Output")) {
        return "This output binding overlaps another output route.";
      }
      return "This binding overlaps another binding.";
    }

    if (columnId === "source" && rowData.inputOverlap) {
      return `${rowData.fixtureLabel} has overlapping input bindings.`;
    }
    if (columnId === "target" && rowData.outputOverlap) {
      return `${rowData.fixtureLabel} has overlapping DMX output bindings.`;
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
          : `binding:${row.fixtureUid}:${row.binding.id}`,
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
                displayData: `In - ${item.bindingCounts.input}x`,
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
                displayData: `DMX - ${item.bindingCounts.output}x`,
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

        const binding = item.binding;
        const isChild = item.rowKind === "binding";

        let cell: GridCell;
        switch (colId) {
          case "fixture":
            cell = makeSafeTextCell("");
            break;
          case "type":
            cell = makeSafeTextCell(binding.kind);
            break;
          case "source":
            cell = {
              ...makeSafeTextCell(binding.source),
              themeOverride: item.conflictColumns.has("source")
                ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                : undefined,
            };
            break;
          case "target":
            cell = {
              ...makeSafeTextCell(binding.target),
              themeOverride: item.conflictColumns.has("target")
                ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                : undefined,
            };
            break;
          case "priority":
            cell = {
              kind: GridCellKind.Number,
              data: binding.priority,
              displayData: String(binding.priority),
              allowOverlay: false,
            };
            break;
          case "clone":
            cell = {
              kind: GridCellKind.Boolean,
              data: binding.clone,
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
        if (row.rowKind === "binding") {
          return Array.from(row.conflictColumns).map(
            (column) => `${row.fixtureUid}:${row.binding.id}:${column}`,
          );
        }

        return [
          row.inputOverlap ? `${row.fixtureUid}:source` : undefined,
          row.outputOverlap ? `${row.fixtureUid}:target` : undefined,
        ].filter((key): key is string => key !== undefined);
      })
      .join("|"),
  );

  /** Navigates from a grouped fixture row to its binding detail row. */
  const navigateToBindingRow = (rowData: FixtureDisplayRow): boolean => {
    const bindingId = getBindingIdForAltFollow(rowData, true);
    if (!bindingId || !props.onNavigateToBinding) {
      return false;
    }

    props.onNavigateToBinding(bindingId);
    return true;
  };

  /** Handles grouped fixture clicks for expansion and shortcut navigation. */
  const handleCellClicked = (cell: Item, event: CellClickedEventArgs) => {
    const [col, row] = cell;
    const rowData = displayRows()[row];
    if (!rowData) return;
    const altKey = (event as CellClickedEventArgs & { altKey?: boolean })
      .altKey;

    if (altKey === true && navigateToBindingRow(rowData)) {
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

  /** Opens right-click affordances for grouped fixture binding rows. */
  const handleCellContextMenu = (cell: Item, event: MouseEvent) => {
    const [, row] = cell;
    const rowData = displayRows()[row];
    if (rowData?.rowKind !== "binding") {
      return;
    }

    event.preventDefault();
    const items: ContextMenuEntry[] = [
      {
        id: "show-binding",
        label: "Show binding",
        icon: ArrowsClockwiseIcon,
        shortcut: "Alt+Click",
        disabled: props.onNavigateToBinding === undefined,
        onSelect: () => navigateToBindingRow(rowData),
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
        fallback={<div class="p-4 text-gray-500">Loading fixtures...</div>}
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
