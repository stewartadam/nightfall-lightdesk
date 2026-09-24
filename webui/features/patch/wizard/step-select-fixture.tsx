// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Input } from "../../../components/ui/form-controls";
import { Table, TableScroll } from "../../../components/ui/table";
import { libraryDefinitionId } from "../../../lib/fixture-service";
import { fixtureLibrary } from "../../../state/appStores";
import type { AvailableFixtureInfo } from "../../../types";
import { LibraryFixturePreview } from "../../fixture-library";
import { usePatchWizard } from "./wizard-context";

export function StepSelectFixture() {
  const { state, updateState } = usePatchWizard();
  const $fixtureLibrary = useStore(fixtureLibrary);
  const [filterText, setFilterText] = createSignal("");

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

  const handleFixtureSelect = (fixture: AvailableFixtureInfo) => {
    const fixtureId = libraryDefinitionId(fixture);
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

        <TableScroll
          aria-label="Fixture library"
          class="flex-1 min-h-0  border border-gray-700 rounded bg-neutral-900"
          role="region"
        >
          <Show
            when={filteredFixtures().length > 0}
            fallback={
              <div class="p-4 text-gray-500 text-sm text-center">
                <Show
                  when={$fixtureLibrary().length === 0}
                  fallback="No fixtures match your search"
                >
                  No fixtures in library. Upload GDTF files to get started.
                </Show>
              </div>
            }
          >
            <Table aria-label="Available fixtures">
              <thead>
                <tr>
                  <th scope="col" class="text-left">
                    Make
                  </th>
                  <th scope="col" class="text-left">
                    Model
                  </th>
                  <th scope="col" class="text-left">
                    Modes
                  </th>
                  <th scope="col" class="text-left">
                    Format
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={filteredFixtures()}>
                  {(fixture) => {
                    const fixtureId = () => libraryDefinitionId(fixture);

                    const isSelected = () =>
                      state().fixtureDefinitionId === fixtureId();

                    return (
                      <tr
                        class="cursor-pointer"
                        data-selected={isSelected() ? "true" : "false"}
                        onClick={() => handleFixtureSelect(fixture)}
                      >
                        <td>{fixture.make}</td>
                        <td>{fixture.model}</td>
                        <td>{fixture.modes.length}</td>
                        <td>{fixture.source_format}</td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </Table>
          </Show>
        </TableScroll>
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
                make={fixture().make}
                model={fixture().model}
                mode={state().fixtureMode ?? undefined}
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
