// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CloudArrowDownIcon } from "@squidlab/phosphor-solid/cloud-arrow-down";
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
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";
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
  DISABLED_TEXT_COLOR,
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
import { commandClient } from "../../../lib/engine-commands";
import {
  libraryDefinitionId,
  libraryRevisionLabel,
} from "../../../lib/fixture-service";
import { getLogger } from "../../../lib/logger";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import {
  fixtureLibrary,
  runtimeCapabilities,
  unloadableFixtureFiles,
} from "../../../state/appStores";
import type {
  AvailableFixtureInfo,
  FixtureLibraryCommand,
  FixtureLibraryEntry,
  UnloadableFixtureFile,
  UnloadableFixtureFileId,
} from "../../../types";
import { GdtfShareBrowser } from "../../gdtf-share";
import { usePropertiesInspector } from "../../property-inspector";
import FixtureLibraryProperties from "../components/fixture-library-properties";
import {
  type FixtureLibraryRow,
  fixtureLibrarySelection,
  setFixtureLibrarySelectedFixture,
  setFixtureLibrarySelection,
} from "../state/selection";

const log = getLogger(import.meta.url);

/** Marks the first cell of a library file that failed to load. */
const UNLOADABLE_INDICATORS = [
  { label: "Failed to load", tone: "warning", variant: "icon" },
] as const;

/** Grid key of a library row, unique across loaded profiles and unloadable files. */
function libraryRowId(row: FixtureLibraryRow): string {
  return row.kind === "fixture"
    ? libraryDefinitionId(row.fixture)
    : JSON.stringify(["unloadable", row.file.in_showfile, row.file.file_name]);
}

/** Names the definition format of an unloadable file from its extension. */
function unloadableSourceFormat(file: UnloadableFixtureFile): string {
  return file.file_name.toLowerCase().endsWith(".gdtf") ? "GDTF" : "OFL";
}

/**
 * Returns the text a column shows and filters on for one row. A file that failed to load
 * shows "Failed to load" as its make, its file name as the model and the error as its modes.
 */
function libraryRowText(row: FixtureLibraryRow, column: string): string {
  if (row.kind === "unloadable") {
    switch (column) {
      case "make":
        return "Failed to load";
      case "model":
        return row.file.file_name;
      case "modes":
        return row.file.error;
      case "source":
        return unloadableSourceFormat(row.file);
      default:
        return "";
    }
  }
  const { fixture } = row;
  switch (column) {
    case "make":
      return fixture.make;
    case "model":
      return fixture.model;
    case "modes":
      return fixture.modes.join(", ");
    case "source":
      return fixture.source_format;
    case "revision":
      return libraryRevisionLabel(fixture.asset_etag);
    default:
      return "";
  }
}

interface FixtureLibraryPanelProps extends BasePanelComponentProps {
  initialPanelId?: string;
}

const FixtureLibraryPanel: Component<FixtureLibraryPanelProps> = (props) => {
  log.trace("mounting");
  const panelId = props.initialPanelId ?? props.id;
  const $fixtureLibrary = useStore(fixtureLibrary);
  const $unloadableFiles = useStore(unloadableFixtureFiles);
  const $selection = useStore(fixtureLibrarySelection);

  /** The loaded profile selected for the properties panel, if a profile row is selected. */
  const selectedFixture = createMemo(() => {
    const row = $selection();
    return row?.kind === "fixture" ? row.fixture : null;
  });

  /**
   * The file that failed to load selected for the properties panel, as the latest scan
   * reports it, or null once a rescan no longer lists it.
   */
  const selectedUnloadable = createMemo(() => {
    const row = $selection();
    if (row?.kind !== "unloadable") return null;
    return (
      $unloadableFiles().find(
        (file) =>
          file.file_name === row.file.file_name &&
          file.in_showfile === row.file.in_showfile,
      ) ?? null
    );
  });
  const capabilities = useStore(runtimeCapabilities);

  /** Whether the runtime can import and delete fixture definition files. */
  const canManageLibrary = createMemo(
    () => capabilities()?.fixture_library === "Native",
  );

  /** Whether the engine can search GDTF Share and install fixtures from it. */
  const gdtfShareAvailable = createMemo(() =>
    Boolean(capabilities()?.gdtf_share),
  );

  /** Whether the panel shows GDTF Share search in place of the library list. */
  const [searchingOnline, setSearchingOnline] = createSignal(false);
  const [onlineQuery, setOnlineQuery] = createSignal("");

  /** Leaves GDTF Share search and shows a library entry in the properties panel. */
  const showLibraryCopy = (fixture: AvailableFixtureInfo) => {
    setSearchingOnline(false);
    setFixtureLibrarySelectedFixture(fixture);
  };

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

      commandClient.emit("FixtureLibraryCommand", command);
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

  /**
   * Deletes the selected rows: profile revisions through `DeleteFixtures`, and files that
   * failed to load through `DeleteUnloadableFiles`.
   */
  const handleDeleteSelected = () => {
    const indices = selectedRows();
    if (indices.length === 0) return;

    const fixtureData = fixtures();
    const fixturesToDelete: FixtureLibraryEntry[] = [];
    const filesToDelete: UnloadableFixtureFileId[] = [];

    for (const idx of indices) {
      const row = fixtureData[idx];
      if (row?.kind === "fixture") {
        fixturesToDelete.push({
          make: row.fixture.make,
          model: row.fixture.model,
          asset_etag: row.fixture.asset_etag,
        });
      } else if (row) {
        filesToDelete.push({
          file_name: row.file.file_name,
          in_showfile: row.file.in_showfile,
        });
      }
    }

    if (fixturesToDelete.length === 0 && filesToDelete.length === 0) return;

    clearSelection();

    if (fixturesToDelete.length > 0) {
      const command: FixtureLibraryCommand = {
        type: "DeleteFixtures",
        data: fixturesToDelete,
      };
      commandClient.emit("FixtureLibraryCommand", command);
    }
    if (filesToDelete.length > 0) {
      const command: FixtureLibraryCommand = {
        type: "DeleteUnloadableFiles",
        data: filesToDelete,
      };
      commandClient.emit("FixtureLibraryCommand", command);
    }
  };

  // Register properties panel
  usePropertiesInspector(
    panelId,
    "Fixture Library",
    () => (
      <FixtureLibraryProperties
        selectedFixture={selectedFixture}
        unloadableFile={selectedUnloadable}
      />
    ),
    { priority: 10, autoActivate: true },
  );

  /**
   * Lists library rows: loaded profiles sorted by make, model, then revision so revisions of
   * one model keep a stable order, followed by the files that failed to load, by file name.
   */
  const sortedFixtures = createMemo((): FixtureLibraryRow[] => {
    const loaded = [...$fixtureLibrary()]
      .sort(
        (a, b) =>
          a.make.localeCompare(b.make) ||
          a.model.localeCompare(b.model) ||
          a.asset_etag.localeCompare(b.asset_etag),
      )
      .map((fixture): FixtureLibraryRow => ({ kind: "fixture", fixture }));
    const unloadable = [...$unloadableFiles()]
      .sort((a, b) => a.file_name.localeCompare(b.file_name))
      .map((file): FixtureLibraryRow => ({ kind: "unloadable", file }));
    return [...loaded, ...unloadable];
  });

  // Column definitions for data grid
  const columns: FilterableGridColumn<
    FixtureLibraryRow,
    VisibilityGridColumn
  >[] = [
    {
      title: "Make",
      id: "make",
      width: 150,
      filter: { value: (row) => libraryRowText(row, "make") },
      ...alwaysVisibleColumnMeta("Identity", "Make"),
    },
    {
      title: "Model",
      id: "model",
      width: 150,
      filter: { value: (row) => libraryRowText(row, "model") },
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
    {
      title: "Revision",
      id: "revision",
      width: 90,
      ...columnVisibilityMeta("Metadata", "Revision"),
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

  /**
   * Provides cells from keyed row and column snapshots. Files that failed to load are greyed
   * out, with a warning sign before the file name.
   */
  const cellProvider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: fixtures(),
      columns: displayColumns(),
      rowKey: libraryRowId,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row, column }): GridCell => {
        const colId = String(column.id);
        const cell = makeSafeTextCell(libraryRowText(row, colId));
        if (row.kind === "fixture") return cell;
        return {
          ...cell,
          themeOverride: { textDark: DISABLED_TEXT_COLOR },
          stateIndicators:
            colId === "make" ? [...UNLOADABLE_INDICATORS] : undefined,
        };
      },
    }),
  );

  /** Shows the clicked row, a profile or a file that failed to load, in the properties panel. */
  const handleCellClicked = (cell: Item) => {
    const [, index] = cell;
    const row = fixtures()[index];

    if (!row) {
      log.warn(`Could not find fixture for clicked row ${index}`);
      return;
    }
    setFixtureLibrarySelection(row);
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
        <Show when={gdtfShareAvailable()}>
          <ToggleToolbarButton
            label="Search GDTF Share"
            pressed={searchingOnline()}
            onClick={() => setSearchingOnline(!searchingOnline())}
            data-testid="fixture-library-search-online"
          >
            <CloudArrowDownIcon class="size-4" aria-hidden />
          </ToggleToolbarButton>
        </Show>
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
        {searchingOnline() ? (
          <div class="h-full p-3">
            <GdtfShareBrowser
              query={onlineQuery()}
              onQueryChange={setOnlineQuery}
              onUse={showLibraryCopy}
              useLabel="Show"
            />
          </div>
        ) : fixtures().length === 0 ? (
          <div class="p-4 text-center text-gray-500">
            {sortedFixtures().length === 0
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
