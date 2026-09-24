// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, For, Show } from "solid-js";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Button } from "../../../components/ui/visual-language/button";
import {
  computeFixtureChannelCount,
  libraryDefinitionId,
} from "../../../lib/fixture-service";
import { fixtureLibrary, fixtureProfile } from "../../../state/appStores";
import { LibraryFixturePreview } from "../../fixture-library";
import { usePatchWizard } from "./wizard-context";

export function StepSelectMode() {
  const { state, updateState } = usePatchWizard();
  const $fixtureLibrary = useStore(fixtureLibrary);
  const $fixtureProfile = useStore(fixtureProfile);

  const selectedFixture = createMemo(() => {
    const defId = state().fixtureDefinitionId;
    if (!defId) return null;
    return $fixtureLibrary().find((f) => libraryDefinitionId(f) === defId);
  });

  const modes = createMemo(() => selectedFixture()?.modes ?? []);

  /** Channel count is computed from profile fixture metadata (populated by LibraryFixturePreview's fetch) */
  const channelCount = createMemo(() => {
    const profile = $fixtureProfile();
    const fixture = selectedFixture();
    if (
      !profile?.fixture ||
      !fixture ||
      profile.info.make !== fixture.make ||
      profile.info.model !== fixture.model
    ) {
      return null;
    }
    return computeFixtureChannelCount(profile.fixture);
  });

  const handleModeSelect = (mode: string) => {
    updateState({ fixtureMode: mode });
  };

  return (
    <div class="patch-wizard-picker">
      {/* Mode list */}
      <div class="flex-1 flex flex-col min-w-0 min-h-0">
        <div class="mb-3">
          <div class="text-sm text-gray-400">
            Select a mode for{" "}
            <span class="text-gray-200">
              {selectedFixture()?.make} {selectedFixture()?.model}
            </span>
          </div>
        </div>

        <ScrollArea
          class="flex-1 border border-gray-700 rounded bg-neutral-900"
          viewportProps={{
            role: "region",
            "aria-label": "Fixture modes",
            tabIndex: 0,
          }}
        >
          <Show
            when={modes().length > 0}
            fallback={
              <div class="p-4 text-gray-500 text-sm text-center">
                No modes available for this fixture
              </div>
            }
          >
            <div class="divide-y divide-gray-800">
              <For each={modes()}>
                {(mode) => {
                  const isSelected = () => state().fixtureMode === mode;

                  return (
                    <Button
                      size="compact"
                      class="w-full !justify-start"
                      variant={isSelected() ? "primary" : "subtle"}
                      aria-pressed={isSelected()}
                      onClick={() => handleModeSelect(mode)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleModeSelect(mode);
                        }
                      }}
                    >
                      {mode}
                    </Button>
                  );
                }}
              </For>
            </div>
          </Show>
        </ScrollArea>
      </div>

      {/* Preview panel */}
      <div class="patch-wizard-preview">
        <div class="text-sm text-gray-400 mb-2">Preview</div>
        <div class="flex-1 border border-gray-700 rounded bg-neutral-900 overflow-hidden">
          <Show
            when={selectedFixture() && state().fixtureMode}
            fallback={
              <div class="h-full flex items-center justify-center text-gray-500 text-sm">
                Select a mode to preview
              </div>
            }
          >
            <LibraryFixturePreview
              make={selectedFixture()!.make}
              model={selectedFixture()!.model}
              mode={state().fixtureMode ?? undefined}
            />
          </Show>
        </div>
        <Show when={selectedFixture() && state().fixtureMode}>
          <div class="mt-3 text-sm">
            <div class="text-gray-100 font-medium">{state().fixtureMode}</div>
            <Show when={channelCount() !== null}>
              <div class="text-gray-400">{channelCount()} DMX channels</div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
