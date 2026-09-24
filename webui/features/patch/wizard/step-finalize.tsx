// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, Show } from "solid-js";
import {
  computeFixtureChannelCount,
  libraryDefinitionId,
} from "../../../lib/fixture-service";
import { fixtureLibrary, fixtureProfile } from "../../../state/appStores";
import { LibraryFixturePreview } from "../../fixture-library";
import { usePatchWizard } from "./wizard-context";

export function StepFinalize() {
  const { state } = usePatchWizard();
  const $fixtureLibrary = useStore(fixtureLibrary);
  const $fixtureProfile = useStore(fixtureProfile);
  /** Tracks when the review step is summarizing a fixture morph. */
  const isMorphMode = createMemo(() => state().morphFixtureIds.length > 0);

  const selectedFixture = createMemo(() => {
    const defId = state().fixtureDefinitionId;
    if (!defId) return null;
    return $fixtureLibrary().find((f) => libraryDefinitionId(f) === defId);
  });

  const channelCount = createMemo(() => {
    const profile = $fixtureProfile();
    const fixture = selectedFixture();
    // Compute channel count from profile fixture metadata if it matches
    if (
      profile?.fixture &&
      fixture &&
      profile.info.make === fixture.make &&
      profile.info.model === fixture.model
    ) {
      return computeFixtureChannelCount(profile.fixture);
    }
    return null;
  });

  const totalChannels = createMemo(() => {
    const count = channelCount();
    return count !== null ? count * state().quantity : null;
  });

  const endAddress = createMemo(() => {
    const start = state().startAddress;
    const total = totalChannels();
    if (start === null || total === null) return null;
    return start + total - 1;
  });

  return (
    <div class="flex gap-6 h-full">
      {/* Summary */}
      <div class="flex-1">
        <h3 class="text-lg font-medium text-gray-100 mb-4">
          {isMorphMode() ? "Review Morph" : "Review Configuration"}
        </h3>

        <div class="space-y-4">
          {/* Fixture info */}
          <div class="bg-neutral-800 rounded-lg p-4">
            <div class="text-sm text-gray-400 mb-1">Fixture</div>
            <div class="text-gray-100 font-medium">
              {selectedFixture()?.make} {selectedFixture()?.model}
            </div>
            <div class="text-sm text-gray-400 mt-1">{state().fixtureMode}</div>
          </div>

          {/* Quantity */}
          <div class="bg-neutral-800 rounded-lg p-4">
            <div class="text-sm text-gray-400 mb-1">
              {isMorphMode() ? "Existing Fixtures" : "Quantity"}
            </div>
            <div class="text-gray-100">
              {state().quantity} fixture{state().quantity !== 1 ? "s" : ""}
            </div>
          </div>

          {/* Patch info */}
          <Show
            when={!isMorphMode()}
            fallback={
              <div class="bg-neutral-800 rounded-lg p-4">
                <div class="text-sm text-gray-400 mb-1">Preserved</div>
                <div class="text-gray-100">
                  Fixture IDs, labels, patch bindings, and 3D placement
                </div>
              </div>
            }
          >
            <div class="bg-neutral-800 rounded-lg p-4">
              <div class="text-sm text-gray-400 mb-1">Console DMX</div>
              <Show
                when={state().assignConsoleDmx}
                fallback={
                  <div class="text-gray-100">Not assigned (DMX-less)</div>
                }
              >
                <div class="text-gray-100">
                  {state().universeId}.{state().startAddress}
                  <Show when={endAddress() !== null}>
                    {(() => {
                      const startAddr = state().startAddress ?? 0;
                      const end = endAddress() ?? 0;
                      const startUniverse = state().universeId ?? 0;
                      const endUniverseOffset = Math.floor((end - 1) / 512);
                      const endAddressInUniverse = ((end - 1) % 512) + 1;
                      const endUniverse = startUniverse + endUniverseOffset;
                      const spansMultiple = endUniverse > startUniverse;

                      if (end === startAddr) return null;
                      return spansMultiple
                        ? `–${endUniverse}.${endAddressInUniverse}`
                        : `–${startUniverse}.${endAddressInUniverse}`;
                    })()}
                  </Show>
                </div>
                <Show
                  when={totalChannels() !== null && channelCount() !== null}
                >
                  <div class="text-sm text-gray-400 mt-1">
                    {state().quantity} fixture
                    {state().quantity !== 1 ? "s" : ""} × {channelCount()} ch ={" "}
                    {totalChannels()} channels
                  </div>
                </Show>
              </Show>
            </div>
          </Show>

          {/* Label */}
          <Show when={state().label}>
            <div class="bg-neutral-800 rounded-lg p-4">
              <div class="text-sm text-gray-400 mb-1">Label</div>
              <div class="text-gray-100">{state().label}</div>
            </div>
          </Show>
        </div>

        <div class="mt-6 p-4 bg-blue-900/20 border border-blue-800 rounded-lg">
          <div class="text-sm text-blue-300">
            <Show
              when={isMorphMode()}
              fallback={
                <>
                  Click <strong>Finish</strong> to add{" "}
                  {state().quantity === 1
                    ? "this fixture"
                    : `these ${state().quantity} fixtures`}{" "}
                  to your project.
                </>
              }
            >
              Click <strong>Morph</strong> to update the selected fixture
              definition.
            </Show>
          </div>
        </div>
      </div>

      {/* Preview */}
      <div class="w-72 flex flex-col">
        <div class="text-sm text-gray-400 mb-2">Preview</div>
        <div class="flex-1 border border-gray-700 rounded bg-neutral-900 overflow-hidden min-h-[250px]">
          <Show when={selectedFixture() && state().fixtureMode}>
            <LibraryFixturePreview
              make={selectedFixture()!.make}
              model={selectedFixture()!.model}
              mode={state().fixtureMode ?? undefined}
            />
          </Show>
        </div>
      </div>
    </div>
  );
}
