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
  createUniqueId,
  on,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Checkbox, Input } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { profileMatchesRevision } from "../../../lib/fixture-profile-match";
import {
  computeFixtureChannelCount,
  fetchFixtureProfile,
  libraryDefinitionId,
} from "../../../lib/fixture-service";
import { useSharedStore } from "../../../lib/use-shared-store";
import {
  fixtureLibrary,
  fixtureProfile,
  fixtures,
  routes,
} from "../../../state/appStores";
import {
  CONSOLE_UNIVERSE_SIZE,
  type ConsolePatchProblem,
  collectConsolePatchOccupancy,
  findConsolePatchProblem,
  findFirstFreeConsolePatch,
  formatConsolePatchSpan,
  layoutConsolePatch,
} from "../model/console-patch-allocation";
import { usePatchWizard } from "./wizard-context";

/**
 * Explains why the configured patch cannot be applied, naming the universe of a
 * conflict only when it differs from the typed start universe.
 */
function describePatchProblem(
  problem: ConsolePatchProblem,
  startUniverse: number | null,
): string {
  if (problem.kind === "overrun") {
    return `The fixture runs past channel ${CONSOLE_UNIVERSE_SIZE} of universe ${problem.universe}; choose a lower start address`;
  }
  const universe =
    problem.universe !== startUniverse ? `Universe ${problem.universe} ` : "";
  return `${universe}Address ${problem.address} conflicts with ${problem.label}`;
}

export function StepConfigure() {
  const formId = createUniqueId();
  const { state, updateState, setPatchProblem, patchProblem } =
    usePatchWizard();
  const $fixtures = useSharedStore(fixtures);
  const $fixtureLibrary = useStore(fixtureLibrary);
  const $fixtureProfile = useStore(fixtureProfile);
  const $routes = useStore(routes);

  const occupiedConsoleAddresses = createMemo(() =>
    collectConsolePatchOccupancy($routes(), $fixtures()),
  );

  const selectedFixture = createMemo(() => {
    const defId = state().fixtureDefinitionId;
    if (!defId) return null;
    return $fixtureLibrary().find((f) => libraryDefinitionId(f) === defId);
  });

  onMount(() => {
    const fixture = selectedFixture();
    const mode = state().fixtureMode;
    if (fixture && mode) {
      fetchFixtureProfile(
        fixture.make,
        fixture.model,
        mode,
        fixture.asset_etag,
      );
    }
  });

  const channelCount = createMemo(() => {
    const profile = $fixtureProfile();
    const fixture = selectedFixture();
    if (profileMatchesRevision(profile, fixture) && profile.fixture) {
      return computeFixtureChannelCount(profile.fixture);
    }
    return null;
  });

  /**
   * Console start of each new fixture for the typed universe and address, packed like
   * the routes the wizard creates; empty until the address and fixture size are known.
   */
  const placements = createMemo(() => {
    const { universeId, startAddress, quantity } = state();
    const footprint = channelCount();
    if (universeId === null || startAddress === null || footprint === null) {
      return [];
    }
    return layoutConsolePatch(
      { universe: universeId, address: startAddress },
      Math.max(footprint, 1),
      quantity,
    );
  });

  /**
   * Fills in the first universe and address, from universe 1, where every new fixture
   * lands on free channels.
   */
  const fillNextAvailable = () => {
    const start = findFirstFreeConsolePatch(
      occupiedConsoleAddresses(),
      Math.max(channelCount() ?? 1, 1),
      state().quantity,
      1,
    ) ?? { universe: 1, address: 1 };
    updateState({ universeId: start.universe, startAddress: start.address });
  };

  /**
   * Starts the patch on the next available channels once the fixture size is known,
   * unless a universe was already chosen.
   */
  createEffect(
    on(
      () => ({
        assignConsoleDmx: state().assignConsoleDmx,
        footprint: channelCount(),
      }),
      ({ assignConsoleDmx, footprint }) => {
        if (
          assignConsoleDmx &&
          footprint !== null &&
          untrack(state).universeId === null
        ) {
          untrack(fillNextAvailable);
        }
      },
    ),
  );

  const totalChannelsNeeded = createMemo(() => {
    const count = channelCount();
    const quantity = state().quantity;
    return count !== null ? count * quantity : null;
  });

  const addressValid = createMemo(() => {
    if (!state().assignConsoleDmx) return true;
    const address = state().startAddress;
    if (address === null) return true;
    return address >= 1 && address <= CONSOLE_UNIVERSE_SIZE;
  });

  /** Publishes the first overrun or conflicting channel of the configured patch to the wizard. */
  createEffect(() => {
    const footprint = channelCount();
    if (!state().assignConsoleDmx || footprint === null) {
      setPatchProblem(null);
      return;
    }
    setPatchProblem(
      findConsolePatchProblem(
        occupiedConsoleAddresses(),
        placements(),
        footprint,
      ),
    );
  });

  /** Applies a typed console universe, keeping the start address. */
  const handleUniverseChange = (value: string) => {
    const universeId = Number.parseInt(value, 10);
    if (!Number.isNaN(universeId) && universeId >= 1) {
      updateState({ universeId });
    }
  };

  /** Applies a typed start address within the console universe. */
  const handleAddressChange = (value: string) => {
    const address = Number.parseInt(value, 10);
    if (
      !Number.isNaN(address) &&
      address >= 1 &&
      address <= CONSOLE_UNIVERSE_SIZE
    ) {
      updateState({ startAddress: address });
    }
  };

  const handleQuantityChange = (value: string) => {
    const quantity = Number.parseInt(value, 10);
    if (!Number.isNaN(quantity) && quantity >= 1) {
      updateState({ quantity });
    }
  };

  const handleLabelChange = (value: string) => {
    updateState({ label: value });
  };

  /** Turns console DMX assignment on or off for the new fixtures. */
  const handleAssignConsoleDmxChange = (checked: boolean) => {
    updateState({ assignConsoleDmx: checked });
  };

  return (
    <div class="space-y-6">
      <div>
        <label
          for={`${formId}-label`}
          class="block text-sm font-medium text-gray-300 mb-2"
        >
          Label (optional)
        </label>
        <Input
          density="compact"
          type="text"
          id={`${formId}-label`}
          placeholder="e.g., Front Wash, Spot 1"
          value={state().label}
          onInput={(e) =>
            handleLabelChange((e.target as HTMLInputElement).value)
          }
          class="w-full"
        />
      </div>

      <div>
        <label
          for={`${formId}-quantity`}
          class="block text-sm font-medium text-gray-300 mb-2"
        >
          Quantity
        </label>
        <Input
          density="compact"
          type="number"
          min="1"
          id={`${formId}-quantity`}
          value={state().quantity}
          onInput={(e) =>
            handleQuantityChange((e.target as HTMLInputElement).value)
          }
          class="w-20"
        />
      </div>

      <div>
        <label class="inline-flex items-center gap-2 text-sm font-medium text-gray-200">
          <Checkbox
            checked={state().assignConsoleDmx}
            onChange={(e) =>
              handleAssignConsoleDmxChange(
                (e.target as HTMLInputElement).checked,
              )
            }
          />
          Assign Console DMX
        </label>
        <p class="mt-1 text-sm text-gray-500">
          Disable for DMX-less patching (fixtures are created without console
          address assignment).
        </p>
      </div>

      <Show when={state().assignConsoleDmx}>
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-2">
            Patch
          </label>
          <div class="flex items-center gap-2">
            <Input
              density="compact"
              type="number"
              min="1"
              value={state().universeId ?? ""}
              onInput={(e) =>
                handleUniverseChange((e.target as HTMLInputElement).value)
              }
              aria-label="Universe"
              placeholder="Univ"
              class="w-20"
            />
            <span class="text-gray-400">.</span>
            <Input
              density="compact"
              type="number"
              min="1"
              max={CONSOLE_UNIVERSE_SIZE}
              aria-label="Start address"
              value={state().startAddress ?? ""}
              onInput={(e) =>
                handleAddressChange((e.target as HTMLInputElement).value)
              }
              class="w-20"
              aria-invalid={!addressValid() || patchProblem() !== null}
            />
            <Button
              size="compact"
              type="button"
              onClick={fillNextAvailable}
              title="Use the first universe and address with room for every fixture"
            >
              Next available
            </Button>
          </div>

          <Show when={totalChannelsNeeded() !== null}>
            <p class="mt-1 text-sm text-gray-500">
              {state().quantity} fixture{state().quantity !== 1 ? "s" : ""} x{" "}
              {channelCount()} ch = {totalChannelsNeeded()} channels (
              {formatConsolePatchSpan(placements(), channelCount() ?? 0)})
            </p>
          </Show>

          <Show when={!addressValid()}>
            <p class="mt-1 text-sm text-red-400">
              Start address must be between 1 and {CONSOLE_UNIVERSE_SIZE}
            </p>
          </Show>
          <Show when={patchProblem()}>
            {(problem) => (
              <p class="mt-1 text-sm text-red-400">
                {describePatchProblem(problem(), state().universeId)}
              </p>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
