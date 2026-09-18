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
import DataGrid, {
  createKeyedDataGridCellProvider,
  type DataGridCellEdit,
} from "../../../components/widgets/data-grid";
import ColumnVisibilityMenu from "../../../components/widgets/data-grid/extensions/column-visibility-menu";
import DataGridFilterMenu from "../../../components/widgets/data-grid/extensions/data-grid-filter-menu";
import { createDataGridFilterState } from "../../../components/widgets/data-grid/extensions/model/data-grid-filter-state";
import { PROGRAMMER_SELECTION_ID_TEXT_COLOR } from "../../../lib/constants";
import type {
  GridCell,
  GridSelection,
  GroupHeaderClickedEventArgs,
  Item,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  emptyGridSelection,
  getEditTargetRowIndices,
  getRowsToEdit,
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
import {
  computeFixtureChannelCount,
  sendDeleteFixture,
  sendFixturePlacementUpdates,
} from "../../../lib/fixture-service";
import { getLogger } from "../../../lib/logger";
import { setStoreAction } from "../../../lib/nanostore-action";
import {
  orderedUidListsEqual,
  replaceFixtureUidsInSelection,
} from "../../../lib/visualizer-selection";
import {
  fixtures,
  programmerSelection,
  visualizerEditSelection,
} from "../../../state/appStores";
import type * as types from "../../../types";

export interface PatchFixtureListTabProps {
  panelId: string;
  onSelectionCountChange?: (count: number) => void;
  onSelectedFixtureIdsChange?: (ids: number[]) => void;
  onDeleteActionChange?: (action: (() => void) | null) => void;
  onColumnVisibilityControlChange?: (control: JSX.Element | null) => void;
}

type FixtureRow = {
  uid: string;
  id: number;
  label: string;
  make: string;
  model: string;
  mode: string;
  channelWidth: number;
  posX: number;
  posY: number;
  posZ: number;
  rotX: number;
  rotY: number;
  rotZ: number;
};

const DEFAULT_COLUMNS: FilterableGridColumn<
  FixtureRow,
  VisibilityGridColumn
>[] = [
  {
    title: "ID",
    id: "id",
    width: 70,
    filter: { kind: "number", value: (row) => row.id },
    ...alwaysVisibleColumnMeta(),
  },
  {
    title: "Label",
    id: "label",
    width: 180,
    group: "Fixture",
    filter: { value: (row) => row.label },
    ...columnVisibilityMeta("Metadata", "Label"),
  },
  {
    title: "Make",
    id: "make",
    width: 140,
    group: "Fixture",
    filter: { value: (row) => row.make },
    ...columnVisibilityMeta("Metadata", "Make"),
  },
  {
    title: "Model",
    id: "model",
    width: 180,
    group: "Fixture",
    filter: { value: (row) => row.model },
    ...columnVisibilityMeta("Metadata", "Model"),
  },
  {
    title: "Mode",
    id: "mode",
    width: 180,
    group: "Fixture",
    filter: { value: (row) => row.mode },
    ...columnVisibilityMeta("Metadata", "Mode"),
  },
  {
    title: "Ch width",
    id: "ch_width",
    width: 90,
    group: "Fixture",
    filter: {
      kind: "number",
      label: "Channel Width",
      value: (row) => row.channelWidth,
    },
    ...columnVisibilityMeta("Metadata", "Ch width"),
  },
  {
    title: "Pos X",
    id: "pos_x",
    width: 80,
    group: "Position",
    filter: { kind: "number", value: (row) => row.posX },
    ...columnVisibilityMeta("Placement", "Pos X"),
  },
  {
    title: "Pos Y",
    id: "pos_y",
    width: 80,
    group: "Position",
    filter: { kind: "number", value: (row) => row.posY },
    ...columnVisibilityMeta("Placement", "Pos Y"),
  },
  {
    title: "Pos Z",
    id: "pos_z",
    width: 80,
    group: "Position",
    filter: { kind: "number", value: (row) => row.posZ },
    ...columnVisibilityMeta("Placement", "Pos Z"),
  },
  {
    title: "Rot X",
    id: "rot_x",
    width: 80,
    group: "Position",
    filter: { kind: "number", value: (row) => row.rotX },
    ...columnVisibilityMeta("Rotation", "Rot X"),
  },
  {
    title: "Rot Y",
    id: "rot_y",
    width: 80,
    group: "Position",
    filter: { kind: "number", value: (row) => row.rotY },
    ...columnVisibilityMeta("Rotation", "Rot Y"),
  },
  {
    title: "Rot Z",
    id: "rot_z",
    width: 80,
    group: "Position",
    filter: { kind: "number", value: (row) => row.rotZ },
    ...columnVisibilityMeta("Rotation", "Rot Z"),
  },
];

const log = getLogger(import.meta.url);

function formatTransformValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  const normalized = Math.abs(value) < 1e-9 ? 0 : value;
  if (Number.isInteger(normalized)) {
    return String(normalized);
  }
  return normalized.toFixed(3).replace(/\.?0+$/u, "");
}

function toNumericCell(value: number, allowOverlay: boolean): GridCell {
  return {
    kind: GridCellKind.Number,
    data: value,
    displayData: formatTransformValue(value),
    allowOverlay,
  };
}

function parseNumericLike(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseEditedNumber(cell: GridCell): number | null {
  if (cell.kind === GridCellKind.Number) {
    const fromData = parseNumericLike(cell.data);
    if (fromData !== null) {
      return fromData;
    }

    const fromDisplay = parseNumericLike(cell.displayData);
    if (fromDisplay !== null) {
      return fromDisplay;
    }

    return null;
  }

  if (cell.kind === GridCellKind.Text) {
    return parseNumericLike(cell.data);
  }

  return null;
}

function getPlacementOrDefault(fixture: types.Fixture): types.FixturePlacement {
  return (
    fixture.placement ?? {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    }
  );
}

function applyPlacementUpdate(
  fixture: types.Fixture,
  position?: types.FixturePlacementPositionUpdate,
  rotation?: types.FixturePlacementRotationUpdate,
): types.Fixture {
  const currentPlacement = getPlacementOrDefault(fixture);
  const nextPlacement: types.FixturePlacement = {
    position: { ...currentPlacement.position },
    rotation: { ...currentPlacement.rotation },
  };

  if (position) {
    switch (position.type) {
      case "All":
        nextPlacement.position = position.data;
        break;
      case "X":
        nextPlacement.position.x = position.data;
        break;
      case "Y":
        nextPlacement.position.y = position.data;
        break;
      case "Z":
        nextPlacement.position.z = position.data;
        break;
    }
  }

  if (rotation) {
    switch (rotation.type) {
      case "All":
        nextPlacement.rotation = rotation.data;
        break;
      case "X":
        nextPlacement.rotation.x = rotation.data;
        break;
      case "Y":
        nextPlacement.rotation.y = rotation.data;
        break;
      case "Z":
        nextPlacement.rotation.z = rotation.data;
        break;
    }
  }

  return {
    ...fixture,
    placement: nextPlacement,
  };
}

function isNoopEdit(columnId: string, row: FixtureRow, value: number): boolean {
  return (
    (columnId === "pos_x" && row.posX === value) ||
    (columnId === "pos_y" && row.posY === value) ||
    (columnId === "pos_z" && row.posZ === value) ||
    (columnId === "rot_x" && row.rotX === value) ||
    (columnId === "rot_y" && row.rotY === value) ||
    (columnId === "rot_z" && row.rotZ === value)
  );
}

function buildPlacementUpdate(
  columnId: string,
  value: number,
): {
  position?: types.FixturePlacementPositionUpdate;
  rotation?: types.FixturePlacementRotationUpdate;
} {
  switch (columnId) {
    case "pos_x":
      return { position: { type: "X", data: value } };
    case "pos_y":
      return { position: { type: "Y", data: value } };
    case "pos_z":
      return { position: { type: "Z", data: value } };
    case "rot_x":
      return { rotation: { type: "X", data: value } };
    case "rot_y":
      return { rotation: { type: "Y", data: value } };
    case "rot_z":
      return { rotation: { type: "Z", data: value } };
    default:
      return {};
  }
}

export default function PatchFixtureListTab(props: PatchFixtureListTabProps) {
  const $fixtures = useStore(fixtures);
  const [baseColumns, setBaseColumns] =
    createSignal<VisibilityGridColumn[]>(DEFAULT_COLUMNS);
  const [collapsedGroups, setCollapsedGroups] = createSignal<readonly string[]>(
    [],
  );
  const columns = createMemo<VisibilityGridColumn[]>(() => {
    const groups = collapsedGroups();
    return baseColumns().map((column) => {
      const group = column.group;
      if (!group) {
        return {
          ...column,
          hasMenu: true,
        };
      }

      if (!groups.includes(group)) {
        return {
          ...column,
          hasMenu: true,
        };
      }

      return {
        ...column,
        width: 8,
        sizing: "fixed" as const,
        hasMenu: true,
      };
    });
  });
  const displayColumns = createMemo(() => {
    return filterVisibleColumns(columns(), props.panelId);
  });
  const [selection, setSelection] = createSignal<GridSelection>(
    emptyGridSelection(),
  );
  const $programmerSelection = useStore(programmerSelection);
  const programmerSelectionUids = createMemo(
    () => new Set($programmerSelection()),
  );
  /** Returns fixture rows targeted by row markers, active cells, or cell ranges. */
  const selectedRows = (): number[] =>
    getEditTargetRowIndices(selection(), displayRows().length);

  /** Synchronizes patch-grid edit targets into yellow visualizer highlights. */
  const syncEditSelectionFromGridSelection = (gridSelection: GridSelection) => {
    const rowData = displayRows();
    const selectedFixtureUids = getEditTargetRowIndices(
      gridSelection,
      rowData.length,
    )
      .map((rowIndex) => rowData[rowIndex]?.uid)
      .filter((uid): uid is string => Boolean(uid));
    const nextSelection = replaceFixtureUidsInSelection(
      visualizerEditSelection.get(),
      rows().map((row) => row.uid),
      selectedFixtureUids,
    );

    if (!orderedUidListsEqual(visualizerEditSelection.get(), nextSelection)) {
      setStoreAction(
        visualizerEditSelection,
        "Sync Fixture Edit Selection",
        nextSelection,
      );
    }
  };

  /** Applies local grid selection and publishes fixture edit-target highlights. */
  const handleGridSelectionChange = (newSelection: GridSelection) => {
    setSelection(newSelection);
    syncEditSelectionFromGridSelection(newSelection);
  };

  const rows = createMemo<FixtureRow[]>(() =>
    Object.values($fixtures())
      .sort((a, b) => a.identifiers.id - b.identifiers.id)
      .map((fixture) => {
        const placement = getPlacementOrDefault(fixture);
        return {
          uid: fixture.identifiers.uid,
          id: fixture.identifiers.id,
          label: fixture.identifiers.label,
          make: fixture.make,
          model: fixture.model,
          mode: fixture.mode,
          channelWidth: computeFixtureChannelCount(fixture),
          posX: placement.position.x,
          posY: placement.position.y,
          posZ: placement.position.z,
          rotX: placement.rotation.x,
          rotY: placement.rotation.y,
          rotZ: placement.rotation.z,
        };
      }),
  );
  /** Removes this patch tab's fixture UIDs from visualizer edit highlights. */
  const clearEditSelection = () => {
    const nextSelection = replaceFixtureUidsInSelection(
      visualizerEditSelection.get(),
      rows().map((row) => row.uid),
      [],
    );
    if (!orderedUidListsEqual(visualizerEditSelection.get(), nextSelection)) {
      setStoreAction(
        visualizerEditSelection,
        "Clear Fixture Edit Selection",
        nextSelection,
      );
    }
  };
  /** Clears patch row selection and removes stale fixture edit-target highlights. */
  const clearSelection = () => {
    setSelection(emptyGridSelection());
    clearEditSelection();
  };
  const filterColumns = createMemo(() =>
    filterColumnsFromMetadata(DEFAULT_COLUMNS),
  );
  const {
    filters: tableFilters,
    filteredRows: displayRows,
    setFilters: setTableFilters,
  } = createDataGridFilterState({
    scope: `${props.panelId}:fixtures`,
    rows,
    columns: filterColumns,
    onFiltersChange: clearSelection,
  });

  const cellProvider = createMemo(() => {
    const selectedUids = programmerSelectionUids();
    return createKeyedDataGridCellProvider({
      rows: displayRows(),
      columns: displayColumns(),
      rowKey: (row) => row.uid,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: fixtureRow, column }): GridCell => {
        const columnId = column.id;
        let cell: GridCell;
        switch (columnId) {
          case "id":
            cell = makeSafeTextCell(fixtureRow.id);
            break;
          case "label":
            cell = makeSafeTextCell(fixtureRow.label);
            break;
          case "make":
            cell = makeSafeTextCell(fixtureRow.make);
            break;
          case "model":
            cell = makeSafeTextCell(fixtureRow.model);
            break;
          case "mode":
            cell = makeSafeTextCell(fixtureRow.mode);
            break;
          case "ch_width":
            cell = toNumericCell(fixtureRow.channelWidth, false);
            break;
          case "pos_x":
            cell = toNumericCell(fixtureRow.posX, true);
            break;
          case "pos_y":
            cell = toNumericCell(fixtureRow.posY, true);
            break;
          case "pos_z":
            cell = toNumericCell(fixtureRow.posZ, true);
            break;
          case "rot_x":
            cell = toNumericCell(fixtureRow.rotX, true);
            break;
          case "rot_y":
            cell = toNumericCell(fixtureRow.rotY, true);
            break;
          case "rot_z":
            cell = toNumericCell(fixtureRow.rotZ, true);
            break;
          default:
            cell = makeSafeTextCell("");
        }
        if (columnId === "id" && selectedUids.has(fixtureRow.uid)) {
          return {
            ...cell,
            themeOverride: {
              ...cell.themeOverride,
              textDark: PROGRAMMER_SELECTION_ID_TEXT_COLOR,
            },
          };
        }
        return cell;
      },
    });
  });

  const handleGroupHeaderClicked = (
    colIndex: number,
    event: GroupHeaderClickedEventArgs,
  ) => {
    const group = displayColumns()[colIndex]?.group ?? "";
    if (!group) {
      return;
    }

    setCollapsedGroups((current) =>
      current.includes(group)
        ? current.filter((value) => value !== group)
        : [...current, group],
    );
    event.preventDefault();
  };

  const applyPlacementEdits = (
    edits: readonly DataGridCellEdit[],
    useSelection: boolean,
  ) => {
    const startMs = performance.now();
    const rowData = displayRows();
    const batchId = crypto.randomUUID().replace(/-/g, "");
    const fixtureMap = fixtures.get();
    let nextFixtureMap: typeof fixtureMap | null = null;
    const updates: types.FixturePlacementUpdateEntry[] = [];
    let rowsSelected = 0;

    for (const edit of edits) {
      const [col, row] = edit.cell;
      const columnId = displayColumns()[col]?.id;
      if (!columnId) continue;

      const value = parseEditedNumber(edit.newValue);
      if (value === null) {
        continue;
      }

      if (row >= rowData.length) {
        continue;
      }

      const { position, rotation } = buildPlacementUpdate(columnId, value);
      if (!position && !rotation) {
        continue;
      }

      const rowsToEdit = useSelection
        ? getRowsToEdit(selection(), col, row, rowData.length)
        : [row];
      rowsSelected += rowsToEdit.length;

      for (const targetRow of rowsToEdit) {
        const fixtureRow = rowData[targetRow];
        if (!fixtureRow) continue;

        if (isNoopEdit(columnId, fixtureRow, value)) {
          continue;
        }

        const fixture =
          nextFixtureMap?.[fixtureRow.uid] ?? fixtureMap[fixtureRow.uid];
        if (!fixture) continue;

        const updatedFixture = applyPlacementUpdate(
          fixture,
          position,
          rotation,
        );
        if (!nextFixtureMap) {
          nextFixtureMap = { ...fixtureMap };
        }
        nextFixtureMap[fixtureRow.uid] = updatedFixture;
        updates.push({
          id: fixtureRow.id,
          position,
          rotation,
        });
      }
    }

    if (updates.length === 0) {
      const totalMs = performance.now() - startMs;
      log.trace(
        `applyPlacementEdits edits=${edits.length} rowsSelected=${rowsSelected} rowsUpdated=0 totalMs=${totalMs.toFixed(2)}`,
      );
      return;
    }

    if (nextFixtureMap) {
      setStoreAction(fixtures, "Apply Fixture Placement Edits", nextFixtureMap);
    }

    sendFixturePlacementUpdates(updates, batchId);
    const totalMs = performance.now() - startMs;
    log.trace(
      `applyPlacementEdits edits=${edits.length} rowsSelected=${rowsSelected} rowsUpdated=${updates.length} totalMs=${totalMs.toFixed(2)} batchId=${batchId}`,
    );
  };

  const handleCellEdited = (cell: Item, newValue: GridCell) => {
    applyPlacementEdits([{ cell, newValue }], true);
  };

  const handleCellsEdited = (edits: readonly DataGridCellEdit[]) => {
    applyPlacementEdits(edits, false);
  };

  const deleteSelectedFixtures = () => {
    const indices = selectedRows();
    if (indices.length === 0) return;

    const rowData = displayRows();
    for (const idx of indices) {
      const fixtureRow = rowData[idx];
      if (!fixtureRow) continue;
      sendDeleteFixture(fixtureRow.id);
    }

    clearSelection();
  };

  createEffect(() => {
    const rowData = displayRows();
    const selectedFixtureIds = selectedRows()
      .map((rowIndex) => rowData[rowIndex]?.id)
      .filter((id): id is number => id !== undefined);
    props.onSelectionCountChange?.(selectedFixtureIds.length);
    props.onSelectedFixtureIdsChange?.(selectedFixtureIds);
  });

  createEffect(() => {
    props.onDeleteActionChange?.(deleteSelectedFixtures);
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

  onCleanup(() => {
    clearEditSelection();
    props.onSelectionCountChange?.(0);
    props.onSelectedFixtureIdsChange?.([]);
    props.onDeleteActionChange?.(null);
    props.onColumnVisibilityControlChange?.(null);
  });

  return (
    <div class="relative h-full w-full">
      <Show
        when={Object.keys($fixtures()).length > 0}
        fallback={<div class="p-4 text-gray-500">No fixtures available.</div>}
      >
        <DataGrid
          rows={displayRows().length}
          columns={displayColumns()}
          cellProvider={cellProvider}
          onCellEdited={handleCellEdited}
          onCellsEdited={handleCellsEdited}
          rowMarkers="checkbox"
          gridSelection={selection()}
          onGridSelectionChange={handleGridSelectionChange}
          onGroupHeaderClicked={handleGroupHeaderClicked}
          width="100%"
          height="100%"
          primaryColumnIndex={0}
          freezeColumns={1}
          onColumnResize={(column, newSize) => {
            setBaseColumns((prev) =>
              prev.map((c) =>
                c.id === column.id ? { ...c, width: newSize } : c,
              ),
            );
          }}
        />
      </Show>
    </div>
  );
}
