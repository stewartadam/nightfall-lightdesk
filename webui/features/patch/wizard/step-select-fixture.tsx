// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, createSignal, Show } from "solid-js";
import { Input } from "../../../components/ui/form-controls";
import DataGrid, {
  activeGridSelectionRow,
  createKeyedDataGridCellProvider,
  singleRowGridSelection,
} from "../../../components/widgets/data-grid";
import {
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
} from "../../../lib/data-grid-types";
import {
  libraryDefinitionId,
  libraryRevisionLabel,
} from "../../../lib/fixture-service";
import { fixtureLibrary, runtimeCapabilities } from "../../../state/appStores";
import type { AvailableFixtureInfo } from "../../../types";
import { LibraryFixturePreview } from "../../fixture-library";
import { usePatchWizard } from "./wizard-context";

const FIXTURE_COLUMNS: GridColumn[] = [
  { id: "make", title: "Make", width: 140, minWidth: 96, maxWidth: 220 },
  { id: "model", title: "Model", width: 200, minWidth: 120, maxWidth: 320 },
  { id: "modes", title: "Modes", width: 72, sizing: "fixed", align: "right" },
  { id: "format", title: "Format", width: 88, minWidth: 72, maxWidth: 140 },
  { id: "revision", title: "Revision", width: 112, minWidth: 80 },
];

/** Projects one library definition into a sortable cell for the fixture picker. */
function fixtureCell(
  fixture: AvailableFixtureInfo,
  column: GridColumn,
): GridCell {
  switch (column.id) {
    case "make":
      return {
        kind: GridCellKind.Text,
        data: fixture.make,
        contentAlign: "left",
      };
    case "model":
      return {
        kind: GridCellKind.Text,
        data: fixture.model,
        contentAlign: "left",
      };
    case "modes":
      return {
        kind: GridCellKind.Number,
        data: fixture.modes.length,
        displayData: String(fixture.modes.length),
        contentAlign: "right",
      };
    case "format":
      return {
        kind: GridCellKind.Text,
        data: fixture.source_format,
        contentAlign: "left",
      };
    default:
      return {
        kind: GridCellKind.Text,
        data: libraryRevisionLabel(fixture.asset_etag),
        contentAlign: "left",
      };
  }
}

/** Lets the user filter the fixture library and choose a definition to patch, with a live preview. */
export function StepSelectFixture() {
  const { state, updateState } = usePatchWizard();
  const $fixtureLibrary = useStore(fixtureLibrary);
  const capabilities = useStore(runtimeCapabilities);
  const [filterText, setFilterText] = createSignal("");
  const [reportedSelection, setReportedSelection] =
    createSignal<GridSelection>();

  /** Whether the runtime can import fixture definition files into its library. */
  const canImportFixtures = createMemo(
    () => capabilities()?.fixture_library === "Native",
  );

  /** Whether the runtime only offers compiled built-in profiles without file import. */
  const builtInProfilesOnly = createMemo(
    () => capabilities()?.fixture_library === "BuiltInOnly",
  );

  const filteredFixtures = createMemo(() => {
    const rawFixtures = $fixtureLibrary();
    const filter = filterText().toLowerCase();

    // Filter by search text
    const filtered = filter
      ? rawFixtures.filter(
          (f) =>
            f.make.toLowerCase().includes(filter) ||
            f.model.toLowerCase().includes(filter),
        )
      : [...rawFixtures];

    // Sort alphabetically by manufacturer, then model
    return filtered.sort((a, b) => {
      const makeCompare = a.make.localeCompare(b.make);
      if (makeCompare !== 0) return makeCompare;
      return a.model.localeCompare(b.model);
    });
  });

  const selectedFixture = createMemo(() => {
    const defId = state().fixtureDefinitionId;
    if (!defId) return null;
    return $fixtureLibrary().find((f) => libraryDefinitionId(f) === defId);
  });

  /** Keys library rows by definition ID so selection and header sorts survive filtering. */
  const fixtureProvider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: filteredFixtures(),
      columns: FIXTURE_COLUMNS,
      rowKey: (fixture) => libraryDefinitionId(fixture),
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) => fixtureCell(row, column),
    }),
  );

  /** Highlights the wizard's chosen definition wherever it sits in the filtered list. */
  const selection = createMemo(() => {
    const defId = state().fixtureDefinitionId;
    return singleRowGridSelection(
      defId
        ? filteredFixtures().findIndex(
            (fixture) => libraryDefinitionId(fixture) === defId,
          )
        : undefined,
      reportedSelection(),
    );
  });

  /**
   * Chooses a library definition and its first mode, leaving the wizard state
   * untouched when the already-chosen definition is selected again so the
   * user's mode choice survives re-clicks and keyboard moves within the row.
   */
  const handleFixtureSelect = (fixture: AvailableFixtureInfo) => {
    const fixtureId = libraryDefinitionId(fixture);
    if (state().fixtureDefinitionId === fixtureId) return;
    const defaultMode = fixture.modes.length > 0 ? fixture.modes[0] : null;
    updateState({
      fixtureDefinitionId: fixtureId,
      fixtureMode: defaultMode,
    });
  };

  return (
    <div class="patch-wizard-picker">
      {/* Fixture list */}
      <div class="flex-1 flex flex-col min-w-0 min-h-0">
        <div class="mb-3">
          <Input
            density="compact"
            type="text"
            aria-label="Filter fixtures"
            placeholder="Filter by make/model..."
            value={filterText()}
            onInput={(e) => setFilterText((e.target as HTMLInputElement).value)}
            class="w-full"
          />
        </div>

        <section
          aria-label="Fixture library"
          class="flex-1 min-h-0 overflow-hidden border border-gray-700 rounded bg-neutral-900"
        >
          <Show
            when={filteredFixtures().length > 0}
            fallback={
              <div class="p-4 text-gray-500 text-sm text-center">
                <Show
                  when={$fixtureLibrary().length === 0}
                  fallback="No fixtures match your search"
                >
                  <Show
                    when={canImportFixtures()}
                    fallback="No fixture profiles are available."
                  >
                    No fixtures in library. Upload GDTF files to get started.
                  </Show>
                </Show>
              </div>
            }
          >
            <DataGrid
              ariaLabel="Available fixtures"
              readOnly
              columns={FIXTURE_COLUMNS}
              rows={filteredFixtures().length}
              cellProvider={fixtureProvider}
              sortableColumns={FIXTURE_COLUMNS.map((column) => column.id!)}
              freezeColumns={2}
              gridSelection={selection()}
              onGridSelectionChange={(next) => {
                setReportedSelection(next);
                const row = activeGridSelectionRow(next);
                const fixture =
                  row === undefined ? undefined : filteredFixtures()[row];
                if (fixture) handleFixtureSelect(fixture);
              }}
            />
          </Show>
        </section>
        <Show when={builtInProfilesOnly()}>
          <p class="mt-2 text-xs text-gray-500">
            Only built-in profiles are available here. Importing GDTF files
            requires the desktop app.
          </p>
        </Show>
      </div>

      {/* Preview panel */}
      <div class="patch-wizard-preview">
        <div class="text-sm text-gray-400 mb-2">Preview</div>
        <div
          aria-label="Fixture preview"
          class="flex-1 min-h-0 border border-gray-700 rounded bg-neutral-900 overflow-hidden"
          role="region"
        >
          <Show
            when={selectedFixture()}
            fallback={
              <div class="h-full flex items-center justify-center text-gray-500 text-sm">
                Select a fixture to preview
              </div>
            }
          >
            {(fixture) => (
              <LibraryFixturePreview
                fill
                make={fixture().make}
                model={fixture().model}
                mode={state().fixtureMode ?? undefined}
                assetEtag={fixture().asset_etag}
              />
            )}
          </Show>
        </div>
        <Show when={selectedFixture()}>
          {(fixture) => (
            <div class="mt-3 text-sm">
              <div class="text-gray-100 font-medium">
                {fixture().make} {fixture().model}
              </div>
              <div class="text-gray-400">
                {fixture().modes.length} mode
                {fixture().modes.length !== 1 ? "s" : ""} available
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
