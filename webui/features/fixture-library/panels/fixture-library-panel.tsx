// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PlusIcon } from "@squidlab/phosphor-solid/plus";
/**
 * Fixture Library Explorer Panel
 *
 * Displays available fixtures from the library and provides management capabilities:
 * - Upload new fixture files
 * - Delete existing fixtures
 * - Filter by filename/make/model
 * - View detailed information in properties panel
 */

import { useStore } from "@nanostores/solid";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  Show,
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
import { fixtureLibrary, runtimeCapabilities } from "../../../state/appStores";
import type {
  FixtureLibraryCommand,
  FixtureLibraryEntry,
} from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import FixtureLibraryProperties from "../components/fixture-library-properties";
import {
  fixtureLibrarySelectedFixture,
  setFixtureLibrarySelectedFixture,
} from "../state/selection";

const log = getLogger(import.meta.url);

interface FixtureLibraryPanelProps extends BasePanelComponentProps {
  initialPanelId?: string;
}

const FixtureLibraryPanel: Component<FixtureLibraryPanelProps> = (props) => {
  log.trace("mounting");
  const panelId = props.initialPanelId ?? props.id;
  const $fixtureLibrary = useStore(fixtureLibrary);
  const $selectedFixture = useStore(fixtureLibrarySelectedFixture);
  const capabilities = useStore(runtimeCapabilities);

  /** Whether the runtime can import and delete fixture definition files. */
  const canManageLibrary = createMemo(
    () => capabilities()?.fixture_library === "Native",
  );

  // Row selection state (for row checkboxes)
  const [selection, setSelection] = createSignal<GridSelection>(
    emptyGridSelection(),
  );
  const { clearSelection, handleGridSelectionChange } =
    createRowSelectionHelpers(selection, setSelection);
  /** Returns fixture-library rows targeted by row markers, active cells, or cell ranges. */
  const selectedRows = (): number[] =>
    getEditTargetRowIndices(selection(), fixtures().length);

  // Reference to the hidden file input
  let fileInputRef: HTMLInputElement | undefined;

  /** Handle file upload */
  const handleFileUpload = async (file: File) => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);

      const command: FixtureLibraryCommand = {
        type: "UploadFixture",
        data: {
          filename: file.name,
          content: Array.from(data),
        },
      };

      engineRuntime.sendCommand({
        module: "FixtureLibraryCommand",
        command,
      });
    } catch (error) {
      log.error("Failed to upload fixture:", error);
    }
  };

  /** Handle file input change */
  const handleFileSelect = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      await handleFileUpload(file);
      // Reset input
      target.value = "";
    }
  };

  /** Trigger file picker */
  const triggerUpload = () => {
    fileInputRef?.click();
  };

  /** Handle fixture deletion for selected rows */
  const handleDeleteSelected = () => {
    const indices = selectedRows();
    if (indices.length === 0) return;

    const fixtureData = fixtures();
    const fixturesToDelete: FixtureLibraryEntry[] = [];

    for (const idx of indices) {
      const fixture = fixtureData[idx];
      if (fixture) {
        fixturesToDelete.push({ make: fixture.make, model: fixture.model });
      }
    }

    if (fixturesToDelete.length === 0) return;

    clearSelection();

    // Send delete command to backend
    const command: FixtureLibraryCommand = {
      type: "DeleteFixtures",
      data: fixturesToDelete,
    };

    engineRuntime.sendCommand({
      module: "FixtureLibraryCommand",
      command,
    });
  };

  // Register properties panel
  usePropertiesInspector(
    panelId,
    "Fixture Library",
    () => <FixtureLibraryProperties selectedFixture={$selectedFixture} />,
    { priority: 10, autoActivate: true },
  );

  const sortedFixtures = createMemo(() => {
    const rawFixtures = $fixtureLibrary();

    // Sort by make, then model
    return [...rawFixtures].sort((a, b) => {
      const makeCompare = a.make.localeCompare(b.make);
      if (makeCompare !== 0) return makeCompare;
      return a.model.localeCompare(b.model);
    });
  });

  // Column definitions for data grid
  const columns: FilterableGridColumn<
    FixtureLibraryEntry,
    VisibilityGridColumn
  >[] = [
    {
      title: "Make",
      id: "make",
      width: 150,
      filter: { value: (fixture) => fixture.make },
      ...alwaysVisibleColumnMeta("Identity", "Make"),
    },
    {
      title: "Model",
      id: "model",
      width: 150,
      filter: { value: (fixture) => fixture.model },
      ...columnVisibilityMeta("Metadata", "Model"),
    },
    {
      title: "Modes",
      id: "modes",
      width: 200,
      ...columnVisibilityMeta("Metadata", "Modes"),
    },
    {
      title: "Source",
      id: "source",
      width: 100,
      ...columnVisibilityMeta("Metadata", "Source"),
    },
  ];

  const filterColumns = createMemo(() => filterColumnsFromMetadata(columns));

  const {
    filters: tableFilters,
    filteredRows: fixtures,
    setFilters: setTableFilters,
  } = createDataGridFilterState({
    scope: panelId,
    rows: sortedFixtures,
    columns: filterColumns,
    onFiltersChange: clearSelection,
  });

  // Clear selection when fixture list changes (e.g., after delete)
  createEffect(() => {
    // Access the fixtures to track them
    fixtures();
    // Clear selection when fixture list changes
    clearSelection();
  });

  const displayColumns = createMemo(() => {
    return filterVisibleColumns(columns, panelId);
  });

  /** Provides cells from keyed fixture and column snapshots. */
  const cellProvider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: fixtures(),
      columns: displayColumns(),
      rowKey: (fixture) => `${fixture.make}:${fixture.model}`,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: fixture, column }): GridCell => {
        const colId = String(column.id);
        switch (colId) {
          case "make":
            return makeSafeTextCell(fixture.make);
          case "model":
            return makeSafeTextCell(fixture.model);
          case "modes":
            return makeSafeTextCell(fixture.modes.join(", "));
          case "source":
            return makeSafeTextCell(fixture.source_format);
          default:
            return makeSafeTextCell("");
        }
      },
    }),
  );

  /** Handle row click to select fixture */
  const handleCellClicked = (cell: Item) => {
    const [, row] = cell;
    const fixture = fixtures()[row];

    if (!fixture) {
      log.warn(`Could not find fixture for clicked row ${row}`);
      return;
    }
    setFixtureLibrarySelectedFixture(fixture);
  };

  return (
    <div class="h-full w-full flex flex-col bg-neutral-900 text-white">
      {/* Toolbar */}
      <DataGridToolbar
        selectedCount={selectedRows().length}
        onDelete={canManageLibrary() ? handleDeleteSelected : undefined}
      >
        <DataGridFilterMenu
          columns={filterColumns()}
          filters={tableFilters()}
          visibleRows={fixtures().length}
          totalRows={sortedFixtures().length}
          onFiltersChange={setTableFilters}
        />
        <ColumnVisibilityMenu scope={panelId} columns={columns} />
        <Show when={canManageLibrary()}>
          <ToolbarButton label="Upload fixture" onClick={triggerUpload}>
            <PlusIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <input
            ref={fileInputRef}
            type="file"
            class="hidden"
            accept=".gdtf,.json"
            onChange={handleFileSelect}
          />
        </Show>
      </DataGridToolbar>

      {/* Data grid */}
      <div class="flex-1 overflow-hidden">
        {fixtures().length === 0 ? (
          <div class="p-4 text-center text-gray-500">
            {$fixtureLibrary().length === 0
              ? "No fixtures in library"
              : "No fixtures match filter"}
          </div>
        ) : (
          <DataGrid
            columns={displayColumns()}
            rows={fixtures().length}
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
    </div>
  );
};

export default FixtureLibraryPanel;
