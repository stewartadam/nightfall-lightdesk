// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { FolderOpenIcon } from "@squidlab/phosphor-solid/folder-open";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import PanelToolbar from "../../../../components/ui/panel-toolbar";
import { ToolbarButton } from "../../../../components/ui/toolbar-button";
import CrudPanelSearch, {
  createCrudPanelSearch,
  createCrudPanelSearchQueryChangeEffect,
} from "../../../../components/widgets/crud/crud-panel-search";
import DataGrid, {
  createKeyedDataGridCellProvider,
  type DataGridCellEdit,
  type DataGridScrollRequest,
} from "../../../../components/widgets/data-grid";
import ColumnVisibilityMenu from "../../../../components/widgets/data-grid/extensions/column-visibility-menu";
import DataGridFilterMenu from "../../../../components/widgets/data-grid/extensions/data-grid-filter-menu";
import { createDataGridFilterState } from "../../../../components/widgets/data-grid/extensions/model/data-grid-filter-state";
import {
  hasSceneObjectLibraryVersionWarning,
  objectLibraryVersionMap,
} from "../../../../lib/asset-version";
import {
  commandFailureMessage,
  commandSucceeded,
} from "../../../../lib/command-result";
import { PROGRAMMER_SELECTION_ID_TEXT_COLOR } from "../../../../lib/constants";
import type {
  GridCell,
  GridSelection,
  Item,
} from "../../../../lib/data-grid-types";
import { CompactSelection } from "../../../../lib/data-grid-types";
import {
  emptyGridSelection,
  getEditTargetRowIndices,
  getRowsToEdit,
  getSelectedRowIndices,
  makeSafeTextCell,
} from "../../../../lib/datagrid";
import { filterVisibleColumns } from "../../../../lib/datagrid-column-visibility";
import {
  EMPTY_TABLE_FILTERS,
  filterColumnsFromMetadata,
} from "../../../../lib/datagrid-filtering";
import { getLogger } from "../../../../lib/logger";
import {
  setStoreAction,
  setStoreKeyAction,
} from "../../../../lib/nanostore-action";
import type { BasePanelComponentProps } from "../../../../lib/panel-registry";
import {
  deleteSceneObject,
  updateSceneObjectPlacement,
  updateSceneObjectProperties,
  updateSceneObjectsFromLibrary,
} from "../../../../lib/scene-object-service";
import {
  orderedUidListsEqual,
  replaceKnownUidsInSelection,
} from "../../../../lib/visualizer-selection";
import {
  clearSceneObjectNavigationRequest,
  objectLibrary,
  sceneObjectNavigationRequest,
  sceneObjects,
  visualizerEditSelection,
  visualizerSceneObjectSelection,
} from "../../../../state/appStores";
import type { SceneObject } from "../../../../types";
import { useObjectPatchWizard } from "../../../object-library";
import {
  buildPlacementUpdate,
  columns,
  formatSceneObjectType,
  getScaleValue,
  parseEditedNumber,
  sceneObjectLibraryName,
  toNumericCell,
  withUpdatedScale,
} from "../model/scene-object-grid-model";

const log = getLogger(import.meta.url);

export interface SceneObjectsPanelProps extends BasePanelComponentProps {
  initialPanelId?: string;
}
export default function SceneObjectsPanel(props: SceneObjectsPanelProps) {
  const $sceneObjects = useStore(sceneObjects);
  const $objectLibrary = useStore(objectLibrary);
  const { openWizard: openObjectWizard } = useObjectPatchWizard();
  const panelId = props.initialPanelId ?? props.id;
  const search = createCrudPanelSearch({
    componentId: panelId,
    label: "Search scene objects",
  });

  const [selection, setSelection] = createSignal<GridSelection>(
    emptyGridSelection(),
  );
  const [scrollRequest, setScrollRequest] =
    createSignal<DataGridScrollRequest>();
  const $visualizerSceneObjectSelection = useStore(
    visualizerSceneObjectSelection,
  );
  const $sceneObjectNavigationRequest = useStore(sceneObjectNavigationRequest);
  const selectedSceneObjectUids = createMemo(
    () => new Set($visualizerSceneObjectSelection()),
  );
  /** Returns scene-object rows targeted by row markers, active cells, or cell ranges. */
  const selectedRows = (): number[] =>
    getEditTargetRowIndices(selection(), displayRows().length);
  const [isUpdatingFromLibrary, setIsUpdatingFromLibrary] = createSignal(false);

  const rows = createMemo<SceneObject[]>(() =>
    Object.values($sceneObjects()).sort(
      (a, b) => a.identifiers.id - b.identifiers.id,
    ),
  );
  /** Returns scene-object rows matching the live toolbar search query. */
  const searchedRows = createMemo<SceneObject[]>(() =>
    rows().filter((sceneObject) =>
      search.matches([
        sceneObject.identifiers.id,
        sceneObject.identifiers.label,
        formatSceneObjectType(sceneObject.objectType),
        sceneObjectLibraryName(sceneObject),
      ]),
    ),
  );
  /** Builds row-only grid selection for selected scene-object UIDs. */
  const gridSelectionFromSceneObjectUids = (
    selectedUids: ReadonlySet<string>,
  ): GridSelection => {
    const selectedRowIndices = displayRows()
      .map((row, index) =>
        selectedUids.has(row.identifiers.uid) ? index : null,
      )
      .filter((index): index is number => index !== null);

    return {
      ...emptyGridSelection(),
      rows: CompactSelection.fromArray(selectedRowIndices),
    };
  };
  /** Removes this panel's scene-object UIDs from visualizer edit highlights. */
  const clearEditSelection = () => {
    const nextSelection = replaceKnownUidsInSelection(
      visualizerEditSelection.get(),
      rows().map((row) => row.identifiers.uid),
      [],
    );
    if (!orderedUidListsEqual(visualizerEditSelection.get(), nextSelection)) {
      setStoreAction(
        visualizerEditSelection,
        "Clear Scene Object Edit Selection",
        nextSelection,
      );
    }
  };
  /** Clears scene-object row selection and removes stale edit-target highlights. */
  const clearSelection = () => {
    setSelection(emptyGridSelection());
    setStoreAction(
      visualizerSceneObjectSelection,
      "Clear Scene Object Selection",
      [],
    );
    clearEditSelection();
  };
  createCrudPanelSearchQueryChangeEffect(search, clearSelection);
  const filterColumns = createMemo(() => filterColumnsFromMetadata(columns));
  const {
    filters: tableFilters,
    filteredRows: displayRows,
    setFilters: setTableFilters,
  } = createDataGridFilterState({
    scope: panelId,
    rows: searchedRows,
    columns: filterColumns,
    onFiltersChange: clearSelection,
  });
  const libraryVersionsByName = createMemo(() =>
    objectLibraryVersionMap($objectLibrary()),
  );

  /** Synchronizes scene-object edit targets into yellow visualizer highlights. */
  const syncEditSelectionFromGridSelection = (gridSelection: GridSelection) => {
    const rowData = displayRows();
    const selectedSceneObjectUids = getEditTargetRowIndices(
      gridSelection,
      rowData.length,
    )
      .map((rowIndex) => rowData[rowIndex]?.identifiers.uid)
      .filter((uid): uid is string => Boolean(uid));
    const nextSelection = replaceKnownUidsInSelection(
      visualizerEditSelection.get(),
      rows().map((row) => row.identifiers.uid),
      selectedSceneObjectUids,
    );

    if (!orderedUidListsEqual(visualizerEditSelection.get(), nextSelection)) {
      setStoreAction(
        visualizerEditSelection,
        "Sync Scene Object Edit Selection",
        nextSelection,
      );
    }
  };

  /** Synchronizes row selection into visualizer scene-object selection. */
  const syncSceneObjectSelectionFromGridSelection = (
    gridSelection: GridSelection,
  ) => {
    const rowData = displayRows();
    const selectedSceneObjectUids = getSelectedRowIndices(gridSelection)
      .map((rowIndex) => rowData[rowIndex]?.identifiers.uid)
      .filter((uid): uid is string => Boolean(uid));
    const nextSelection = replaceKnownUidsInSelection(
      visualizerSceneObjectSelection.get(),
      rows().map((row) => row.identifiers.uid),
      selectedSceneObjectUids,
    );

    if (
      !orderedUidListsEqual(visualizerSceneObjectSelection.get(), nextSelection)
    ) {
      setStoreAction(
        visualizerSceneObjectSelection,
        "Sync Scene Object Selection",
        nextSelection,
      );
    }
  };

  /** Applies local grid selection and publishes scene-object edit-target highlights. */
  const handleGridSelectionChange = (newSelection: GridSelection) => {
    setSelection(newSelection);
    syncEditSelectionFromGridSelection(newSelection);
    syncSceneObjectSelectionFromGridSelection(newSelection);
  };

  const gridColumns = createMemo(() => {
    return filterVisibleColumns(
      columns.map((column) => ({ ...column })),
      panelId,
    );
  });

  const cellProvider = createMemo(() => {
    const libraryVersions = libraryVersionsByName();
    const selectedUids = selectedSceneObjectUids();

    return createKeyedDataGridCellProvider({
      rows: displayRows(),
      columns: gridColumns(),
      rowKey: (row) => row.identifiers.uid,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: rowItem, column }): GridCell => {
        const columnId = column.id;
        let cell: GridCell;
        switch (columnId) {
          case "id":
            cell = makeSafeTextCell(rowItem.identifiers.id);
            break;
          case "label":
            cell = makeSafeTextCell(rowItem.identifiers.label);
            break;
          case "type":
            cell = makeSafeTextCell(
              hasSceneObjectLibraryVersionWarning(rowItem, libraryVersions)
                ? `${formatSceneObjectType(rowItem.objectType)} ⚠️`
                : formatSceneObjectType(rowItem.objectType),
            );
            break;
          case "scale": {
            const scale = getScaleValue(rowItem);
            cell = scale === null ? makeSafeTextCell("") : toNumericCell(scale);
            break;
          }
          case "pos_x":
            cell = toNumericCell(rowItem.placement.position.x);
            break;
          case "pos_y":
            cell = toNumericCell(rowItem.placement.position.y);
            break;
          case "pos_z":
            cell = toNumericCell(rowItem.placement.position.z);
            break;
          case "rot_x":
            cell = toNumericCell(rowItem.placement.rotation.x);
            break;
          case "rot_y":
            cell = toNumericCell(rowItem.placement.rotation.y);
            break;
          case "rot_z":
            cell = toNumericCell(rowItem.placement.rotation.z);
            break;
          default:
            cell = makeSafeTextCell("");
        }
        if (columnId === "id" && selectedUids.has(rowItem.identifiers.uid)) {
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

  const handleDeleteSelected = () => {
    const indices = selectedRows();
    if (indices.length === 0) return;

    const rowData = displayRows();
    for (const idx of indices) {
      const sceneObject = rowData[idx];
      if (!sceneObject) continue;
      deleteSceneObject(sceneObject.identifiers.id);
    }

    clearSelection();
  };

  const selectedLibraryLinkedSceneObjectIds = createMemo<number[]>(() => {
    const rowData = displayRows();
    const ids: number[] = [];
    for (const idx of selectedRows()) {
      const sceneObject = rowData[idx];
      if (!sceneObject) continue;
      if (sceneObject.properties.type !== "Custom") continue;
      if (!sceneObject.properties.data.libraryObjectName) continue;
      ids.push(sceneObject.identifiers.id);
    }
    return ids;
  });

  const canUpdateFromLibrary = () =>
    selectedLibraryLinkedSceneObjectIds().length > 0 &&
    !isUpdatingFromLibrary();

  const handleUpdateSelectedFromLibrary = async () => {
    if (!canUpdateFromLibrary()) {
      return;
    }

    const ids = selectedLibraryLinkedSceneObjectIds();
    setIsUpdatingFromLibrary(true);
    try {
      const result = await updateSceneObjectsFromLibrary(ids);
      if (!commandSucceeded(result)) {
        log.warn(
          `Object-library consolidation failed for scene objects [${ids.join(", ")}]: ${commandFailureMessage(result)}`,
        );
        return;
      }

      // Ensure warning state clears immediately even if SceneObjectCommand
      // updates arrive on a later websocket tick.
      const versionsByName = libraryVersionsByName();
      const rowData = displayRows();
      for (const sceneObjectId of ids) {
        const sceneObject = rowData.find(
          (row) => row.identifiers.id === sceneObjectId,
        );
        if (sceneObject?.properties.type !== "Custom") continue;

        const objectName = sceneObject.properties.data.libraryObjectName;
        if (!objectName) continue;

        const libraryVersion = versionsByName.get(objectName);
        if (!libraryVersion) continue;
        if (sceneObject.properties.data.libraryObjectVersion === libraryVersion)
          continue;

        setStoreKeyAction(
          sceneObjects,
          "Update Scene Object Library Version",
          sceneObject.identifiers.uid,
          {
            ...sceneObject,
            properties: {
              type: "Custom",
              data: {
                ...sceneObject.properties.data,
                libraryObjectVersion: libraryVersion,
              },
            },
          },
        );
      }
    } catch (error) {
      log.error("Failed to update selected scene objects from library:", error);
    } finally {
      setIsUpdatingFromLibrary(false);
    }
  };

  const applySceneObjectEdit = (
    cell: Item,
    newValue: GridCell,
    useSelection: boolean,
    batchId = crypto.randomUUID().replace(/-/g, ""),
  ) => {
    const [col, row] = cell;
    const columnId = gridColumns()[col]?.id;
    if (!columnId) return;

    const value = parseEditedNumber(newValue);
    if (value === null) {
      log.debug(`Ignored invalid scene object transform value in ${columnId}`);
      return;
    }

    const rowData = displayRows();
    if (row >= rowData.length) {
      return;
    }

    const rowsToEdit = useSelection
      ? getRowsToEdit(selection(), col, row, rowData.length)
      : [row];

    if (columnId === "scale") {
      for (const targetRow of rowsToEdit) {
        const sceneObject = rowData[targetRow];
        if (!sceneObject) continue;

        const currentSceneObject =
          sceneObjects.get()[sceneObject.identifiers.uid] ?? sceneObject;
        const updatedSceneObject = withUpdatedScale(currentSceneObject, value);
        if (!updatedSceneObject) continue;

        setStoreAction(sceneObjects, "Update Scene Object Scale", {
          ...sceneObjects.get(),
          [sceneObject.identifiers.uid]: updatedSceneObject,
        });
        updateSceneObjectProperties(
          sceneObject.identifiers.id,
          updatedSceneObject.properties,
        );
      }
      return;
    }

    const { position, rotation } = buildPlacementUpdate(columnId, value);
    if (!position && !rotation) {
      return;
    }

    for (const targetRow of rowsToEdit) {
      const sceneObject = rowData[targetRow];
      if (!sceneObject) continue;
      const currentSceneObject =
        sceneObjects.get()[sceneObject.identifiers.uid] ?? sceneObject;

      const updatedSceneObject = {
        ...currentSceneObject,
        placement: {
          ...currentSceneObject.placement,
          position: { ...currentSceneObject.placement.position },
          rotation: { ...currentSceneObject.placement.rotation },
        },
      };
      if (position) {
        switch (position.type) {
          case "All":
            updatedSceneObject.placement.position = position.data;
            break;
          case "X":
            updatedSceneObject.placement.position.x = position.data;
            break;
          case "Y":
            updatedSceneObject.placement.position.y = position.data;
            break;
          case "Z":
            updatedSceneObject.placement.position.z = position.data;
            break;
        }
      }
      if (rotation) {
        switch (rotation.type) {
          case "All":
            updatedSceneObject.placement.rotation = rotation.data;
            break;
          case "X":
            updatedSceneObject.placement.rotation.x = rotation.data;
            break;
          case "Y":
            updatedSceneObject.placement.rotation.y = rotation.data;
            break;
          case "Z":
            updatedSceneObject.placement.rotation.z = rotation.data;
            break;
        }
      }
      setStoreAction(sceneObjects, "Update Scene Object Transform", {
        ...sceneObjects.get(),
        [sceneObject.identifiers.uid]: updatedSceneObject,
      });

      updateSceneObjectPlacement(
        sceneObject.identifiers.id,
        position,
        rotation,
        batchId,
      );
    }
  };

  const handleCellEdited = (cell: Item, newValue: GridCell) => {
    applySceneObjectEdit(cell, newValue, true);
  };

  const handleCellsEdited = (edits: readonly DataGridCellEdit[]) => {
    const batchId = crypto.randomUUID().replace(/-/g, "");
    for (const edit of edits) {
      applySceneObjectEdit(edit.cell, edit.newValue, false, batchId);
    }
  };

  onCleanup(() => {
    clearEditSelection();
  });

  createEffect(() => {
    const nextSelection = gridSelectionFromSceneObjectUids(
      selectedSceneObjectUids(),
    );
    if (
      orderedUidListsEqual(
        getSelectedRowIndices(selection()).map((index) => index.toString()),
        getSelectedRowIndices(nextSelection).map((index) => index.toString()),
      )
    ) {
      return;
    }
    setSelection(nextSelection);
    syncEditSelectionFromGridSelection(nextSelection);
  });

  /** Handles one-shot palette navigation to a scene object row. */
  createEffect(() => {
    const request = $sceneObjectNavigationRequest();
    if (!request) return;

    const targetExists = rows().some(
      (sceneObject) => sceneObject.identifiers.uid === request.sceneObjectUid,
    );
    if (!targetExists) {
      clearSceneObjectNavigationRequest(request.requestId);
      return;
    }

    const rowIndex = displayRows().findIndex(
      (sceneObject) => sceneObject.identifiers.uid === request.sceneObjectUid,
    );
    if (rowIndex < 0) {
      search.clear();
      setTableFilters(EMPTY_TABLE_FILTERS);
      return;
    }

    const nextSelection = {
      ...emptyGridSelection(),
      rows: CompactSelection.fromSingleSelection(rowIndex),
      current: {
        cell: [0, rowIndex] as Item,
        range: {
          x: 0,
          y: rowIndex,
          width: 1,
          height: 1,
        },
        rangeStack: [],
      },
    };
    setSelection(nextSelection);
    setScrollRequest({
      cell: [0, rowIndex],
      requestId: request.requestId,
    });
    syncEditSelectionFromGridSelection(nextSelection);
    syncSceneObjectSelectionFromGridSelection(nextSelection);
    clearSceneObjectNavigationRequest(request.requestId);
  });

  return (
    <div class="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              tooltip={"Add object"}
              type="button"
              onClick={openObjectWizard}
              label="Add object"
            >
              <PlusIcon class="size-4" aria-hidden />
            </ToolbarButton>

            <ToolbarButton
              variant="danger"
              size="labeled"
              tooltip={
                selectedRows().length > 0
                  ? `Delete selected scene objects (${selectedRows().length})`
                  : "Delete selected scene objects (Delete/Backspace)"
              }
              type="button"
              onClick={handleDeleteSelected}
              disabled={selectedRows().length === 0}
              label="Delete selected scene objects"
            >
              <TrashIcon class="size-4" aria-hidden />
              <Show when={selectedRows().length > 0}>
                <span class="rounded bg-red-800 px-1 text-[10px] leading-4 text-red-100">
                  {selectedRows().length}
                </span>
              </Show>
            </ToolbarButton>

            <div class="mx-1 h-6 w-px bg-neutral-700" aria-hidden="true" />

            <ToolbarButton
              tooltip={
                canUpdateFromLibrary()
                  ? `Update selected scene objects from object library (${selectedLibraryLinkedSceneObjectIds().length})`
                  : "Update selected scene objects from object library"
              }
              type="button"
              onClick={() => void handleUpdateSelectedFromLibrary()}
              disabled={!canUpdateFromLibrary()}
              label="Update selected scene objects from object library"
            >
              <FolderOpenIcon class="size-4" aria-hidden />
            </ToolbarButton>
          </>
        }
        right={
          <>
            <CrudPanelSearch
              search={search}
              placeholder="Search scene objects"
            />
            <DataGridFilterMenu
              columns={filterColumns()}
              filters={tableFilters()}
              visibleRows={displayRows().length}
              totalRows={rows().length}
              onFiltersChange={setTableFilters}
            />
            <ColumnVisibilityMenu scope={panelId} columns={columns} />
          </>
        }
      />

      <div class="flex-1 min-h-0">
        <DataGrid
          rows={displayRows().length}
          columns={gridColumns()}
          cellProvider={cellProvider}
          onCellEdited={handleCellEdited}
          onCellsEdited={handleCellsEdited}
          rowMarkers="checkbox"
          gridSelection={selection()}
          scrollRequest={scrollRequest()}
          onGridSelectionChange={handleGridSelectionChange}
          width="100%"
          height="100%"
          primaryColumnIndex={0}
          freezeColumns={1}
        />
      </div>
    </div>
  );
}
