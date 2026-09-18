// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PlusIcon } from "@squidlab/phosphor-solid/plus";
/**
 * Object Library Explorer Panel
 *
 * Displays available objects from the library and provides management capabilities:
 * - Create new objects from GLB files
 * - Delete existing objects
 * - Filter by name/category
 * - View detailed information in properties panel
 */

import { useStore } from "@nanostores/solid";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import DataGrid, {
  createKeyedDataGridCellProvider,
} from "../../../components/widgets/data-grid";
import ColumnVisibilityMenu from "../../../components/widgets/data-grid/extensions/column-visibility-menu";
import DataGridFilterMenu from "../../../components/widgets/data-grid/extensions/data-grid-filter-menu";
import DataGridToolbar from "../../../components/widgets/data-grid/extensions/data-grid-toolbar";
import { createDataGridFilterState } from "../../../components/widgets/data-grid/extensions/model/data-grid-filter-state";
import type {
  GridCell,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import {
  createRowSelectionHelpers,
  emptyGridSelection,
  getEditTargetRowIndices,
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
import { engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { objectLibrary } from "../../../state/appStores";
import type { ObjectLibraryCommand } from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import {
  objectLibrarySelectedObject,
  setObjectLibrarySelectedObject,
} from "../state/selection";
import CreateObjectModal from "./create-object-modal";
import ObjectLibraryProperties from "./object-library-properties";

const log = getLogger(import.meta.url);

interface ObjectLibraryPanelProps extends BasePanelComponentProps {
  initialPanelId?: string;
}

const ObjectLibraryPanel: Component<ObjectLibraryPanelProps> = (props) => {
  log.trace("mounting");
  const panelId = props.initialPanelId ?? props.id;
  const $objectLibrary = useStore(objectLibrary);
  const $selectedObject = useStore(objectLibrarySelectedObject);
  type ObjectLibraryEntry = ReturnType<typeof $objectLibrary>[number];

  const [showCreateModal, setShowCreateModal] = createSignal(false);

  // Row selection state (for row checkboxes)
  const [selection, setSelection] = createSignal<GridSelection>(
    emptyGridSelection(),
  );
  const { clearSelection, handleGridSelectionChange } =
    createRowSelectionHelpers(selection, setSelection);
  /** Returns object-library rows targeted by row markers, active cells, or cell ranges. */
  const selectedRows = (): number[] =>
    getEditTargetRowIndices(selection(), objects().length);

  /** Handle object deletion for selected rows */
  const handleDeleteSelected = () => {
    const indices = selectedRows();
    if (indices.length === 0) return;

    const objectData = objects();
    const objectsToDelete: string[] = [];

    for (const idx of indices) {
      const object = objectData[idx];
      if (object) {
        objectsToDelete.push(object.name);
      }
    }

    if (objectsToDelete.length === 0) return;

    clearSelection();

    // Send delete command to backend
    const command: ObjectLibraryCommand = {
      type: "DeleteObjects",
      data: objectsToDelete,
    };

    engineRuntime.sendCommand({
      module: "ObjectLibraryCommand",
      command,
    });
  };

  // Register properties panel
  usePropertiesInspector(
    panelId,
    "Object Library",
    () => <ObjectLibraryProperties selectedObject={$selectedObject()} />,
    { priority: 10, autoActivate: true },
  );

  const sortedObjects = createMemo(() => {
    const rawObjects = $objectLibrary();

    // Sort by category, then name
    return [...rawObjects].sort((a, b) => {
      const categoryCompare = a.category.localeCompare(b.category);
      if (categoryCompare !== 0) return categoryCompare;
      return a.name.localeCompare(b.name);
    });
  });

  // Column definitions for data grid
  const columns: FilterableGridColumn<
    ObjectLibraryEntry,
    VisibilityGridColumn
  >[] = [
    {
      title: "Name",
      id: "name",
      width: 200,
      filter: { value: (object) => object.name },
      ...alwaysVisibleColumnMeta("Identity", "Name"),
    },
    {
      title: "Category",
      id: "category",
      width: 120,
      filter: { value: (object) => object.category },
      ...columnVisibilityMeta("Metadata", "Category"),
    },
    {
      title: "Scale",
      id: "scale",
      width: 80,
      filter: { kind: "number", value: (object) => object.scale },
      ...columnVisibilityMeta("Metadata", "Scale"),
    },
    {
      title: "Tags",
      id: "tags",
      width: 150,
      filter: { kind: "tag", value: (object) => object.tags ?? [] },
      ...columnVisibilityMeta("Metadata", "Tags"),
    },
  ];

  const filterColumns = createMemo(() => filterColumnsFromMetadata(columns));

  const {
    filters: tableFilters,
    filteredRows: objects,
    setFilters: setTableFilters,
  } = createDataGridFilterState({
    scope: panelId,
    rows: sortedObjects,
    columns: filterColumns,
    onFiltersChange: clearSelection,
  });

  // Clear selection when object list changes (e.g., after delete)
  createEffect(() => {
    // Access the objects to track them
    objects();
    // Clear selection when object list changes
    clearSelection();
  });

  const displayColumns = createMemo(() => {
    return filterVisibleColumns(columns, panelId);
  });

  /** Provides cells from keyed object and column snapshots. */
  const cellProvider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: objects(),
      columns: displayColumns(),
      rowKey: (object) => object.name,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: object, column }): GridCell => {
        const colId = String(column.id);
        switch (colId) {
          case "name":
            return makeSafeTextCell(object.name);
          case "category":
            return makeSafeTextCell(object.category);
          case "scale":
            return makeSafeTextCell(object.scale.toFixed(2));
          case "tags":
            return makeSafeTextCell((object.tags ?? []).join(", "));
          default:
            return makeSafeTextCell("");
        }
      },
    }),
  );

  /** Handle row click to select object */
  const handleCellClicked = (cell: Item) => {
    const [, row] = cell;
    const object = objects()[row];

    if (!object) {
      log.warn(`Could not find object for clicked row ${row}`);
      return;
    }
    setObjectLibrarySelectedObject(object);
  };

  return (
    <div class="h-full w-full flex flex-col bg-neutral-900 text-white">
      {/* Toolbar */}
      <DataGridToolbar
        selectedCount={selectedRows().length}
        onDelete={handleDeleteSelected}
      >
        <DataGridFilterMenu
          columns={filterColumns()}
          filters={tableFilters()}
          visibleRows={objects().length}
          totalRows={sortedObjects().length}
          onFiltersChange={setTableFilters}
        />
        <ColumnVisibilityMenu scope={panelId} columns={columns} />
        <ToolbarButton
          label="Create object"
          onClick={() => setShowCreateModal(true)}
        >
          <PlusIcon class="size-4" aria-hidden />
        </ToolbarButton>
      </DataGridToolbar>

      {/* Data grid */}
      <div class="flex-1 overflow-hidden">
        {objects().length === 0 ? (
          <div class="p-4 text-center text-gray-500">
            {$objectLibrary().length === 0
              ? "No objects in library"
              : "No objects match filter"}
          </div>
        ) : (
          <DataGrid
            columns={displayColumns()}
            rows={objects().length}
            cellProvider={cellProvider}
            onCellClicked={handleCellClicked}
            rowMarkers="checkbox"
            gridSelection={selection()}
            onGridSelectionChange={handleGridSelectionChange}
            width="100%"
            height="100%"
            freezeColumns={1}
          />
        )}
      </div>

      {/* Create Object Modal */}
      <CreateObjectModal
        isOpen={showCreateModal()}
        onClose={() => setShowCreateModal(false)}
      />
    </div>
  );
};

export default ObjectLibraryPanel;
