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
import { normalizeFixtureUid } from "../../../lib/binding-utils";
import { fixtureWireLayout } from "../../../lib/dmx";
import {
  computeFixtureChannelCount,
  fetchFixtureProfile,
  libraryDefinitionId,
} from "../../../lib/fixture-service";
import {
  bindings,
  dmxUniverseData,
  fixtureLibrary,
  fixtureProfile,
  fixtures,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { usePatchWizard } from "./wizard-context";

function rangeOverlaps(lhs?: types.DmxRange, rhs?: types.DmxRange): boolean {
  if (!lhs || !rhs) return true;
  return lhs.start <= rhs.end && rhs.start <= lhs.end;
}

function outputSourceMatches(
  source: types.OutputSource,
  disabled: types.OutputSource,
): boolean {
  if (source.type !== disabled.type) return false;

  if (source.type === "Fixture" && disabled.type === "Fixture") {
    const sourceUids = source.data.uids.map((uid) => normalizeFixtureUid(uid));
    const disabledUids = new Set(
      disabled.data.uids.map((uid) => normalizeFixtureUid(uid)),
    );
    const hasUidMatch = sourceUids.some((uid) => disabledUids.has(uid));
    if (!hasUidMatch) return false;

    const elementMatches =
      disabled.data.element === undefined ||
      source.data.element === disabled.data.element;
    const paramMatches =
      disabled.data.param === undefined ||
      source.data.param === disabled.data.param;
    return elementMatches && paramMatches;
  }

  if (source.type === "Console" && disabled.type === "Console") {
    return (
      rangeOverlaps(source.data.universe, disabled.data.universe) &&
      (disabled.data.address === undefined ||
        source.data.address === undefined ||
        source.data.address === disabled.data.address)
    );
  }

  return false;
}

function mapUniverseByIndex(universes: number[], index: number): number {
  if (universes.length === 0) return 1;
  if (universes.length === 1) return universes[0];
  if (index < universes.length) return universes[index];
  return universes[universes.length - 1];
}

function normalizeParamName(value: string): string {
  return value.trim().toLowerCase();
}

function attributeName(attribute: types.Attribute): string {
  if (attribute.type === "Custom") {
    return attribute.data.label;
  }
  return attribute.type;
}

function computeSourceWidth(
  fixture: types.Fixture,
  elementId?: number,
  paramName?: string,
): number {
  const normalizedParam = paramName ? normalizeParamName(paramName) : undefined;
  return fixtureWireLayout(fixture, {
    elementId,
    includeParameter: normalizedParam
      ? (param) =>
          normalizeParamName(attributeName(param.attribute)) === normalizedParam
      : undefined,
  }).footprint;
}

function collectConsolePatchOccupancy(
  snapshot: types.BindingsSnapshot,
  fixtureMap: Record<string, types.Fixture>,
): Map<string, { label: string }> {
  const occupied = new Map<string, { label: string }>();

  const disabledSources: types.OutputSource[] = [];
  for (const binding of snapshot.disabled) {
    if (binding.type === "Output") {
      disabledSources.push(binding.data.source);
    }
  }
  for (const binding of snapshot.output) {
    if (binding.target.type === "Disabled") {
      disabledSources.push(binding.source);
    }
  }

  for (const binding of snapshot.output) {
    if (binding.source.type !== "Fixture") continue;
    if (binding.target.type !== "Console") continue;

    if (
      disabledSources.some((disabledSource) =>
        outputSourceMatches(binding.source, disabledSource),
      )
    ) {
      continue;
    }

    const sourceData = binding.source.data;
    const targetData = binding.target.data;
    const universes = targetData.universe
      ? Array.from(
          { length: targetData.universe.end - targetData.universe.start + 1 },
          (_, index) => targetData.universe!.start + index,
        )
      : [1];
    const baseAddress = targetData.address ?? 1;

    let runningAddress = baseAddress;
    let lastUniverse = universes[0] ?? 1;

    for (const [index, uid] of sourceData.uids.entries()) {
      const fixtureUid = normalizeFixtureUid(uid);
      const fixture = fixtureMap[fixtureUid];
      if (!fixture) continue;

      const universe = mapUniverseByIndex(universes, index);
      if (universe !== lastUniverse) {
        runningAddress = baseAddress;
        lastUniverse = universe;
      }

      const channelWidth = computeSourceWidth(
        fixture,
        sourceData.element,
        sourceData.param,
      );
      if (channelWidth <= 0) continue;

      const startAddress = binding.clone ? baseAddress : runningAddress;
      const endAddress = startAddress + channelWidth - 1;
      if (!binding.clone) {
        runningAddress = endAddress + 1;
      }

      const fixtureLabel =
        fixture.identifiers.label || `Fixture ${fixture.identifiers.id}`;

      for (let address = startAddress; address <= endAddress; address += 1) {
        occupied.set(`${universe}:${address}`, { label: fixtureLabel });
      }
    }
  }

  return occupied;
}

export function StepConfigure() {
  const formId = createUniqueId();
  const { state, updateState, setPatchConflict, patchConflict } =
    usePatchWizard();
  const $dmxData = useStore(dmxUniverseData);
  const $fixtures = useStore(fixtures);
  const $fixtureLibrary = useStore(fixtureLibrary);
  const $fixtureProfile = useStore(fixtureProfile);
  const $bindings = useStore(bindings);

  const occupiedConsoleAddresses = createMemo(() =>
    collectConsolePatchOccupancy($bindings(), $fixtures()),
  );

  const universeIds = createMemo(() =>
    $dmxData()
      .map((universe) => universe.universe_id)
      .sort((a, b) => a - b),
  );

  const selectedUniverseId = createMemo(() => state().universeId);

  const selectedFixture = createMemo(() => {
    const defId = state().fixtureDefinitionId;
    if (!defId) return null;
    return $fixtureLibrary().find((f) => libraryDefinitionId(f) === defId);
  });

  onMount(() => {
    const fixture = selectedFixture();
    const mode = state().fixtureMode;
    if (fixture && mode) {
      fetchFixtureProfile(fixture.make, fixture.model, mode);
    }
  });

  const channelCount = createMemo(() => {
    const profile = $fixtureProfile();
    const fixture = selectedFixture();
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

  const findNextAvailableAddress = (universeId: number): number => {
    const occupied = untrack(() => occupiedConsoleAddresses());

    let nextAddress = 1;
    while (nextAddress <= 512) {
      if (!occupied.has(`${universeId}:${nextAddress}`)) {
        return nextAddress;
      }
      nextAddress += 1;
    }

    return 1;
  };

  createEffect(
    on(
      () => ({
        ids: universeIds(),
        assignConsoleDmx: state().assignConsoleDmx,
      }),
      ({ ids, assignConsoleDmx }) => {
        if (!assignConsoleDmx) {
          return;
        }

        const currentUniverseId = untrack(() => state().universeId);
        if (ids.length > 0 && currentUniverseId === null) {
          const firstUniverse = ids[0];
          const nextAddress = findNextAvailableAddress(firstUniverse);
          updateState({
            universeId: firstUniverse,
            startAddress: nextAddress,
          });
        }
      },
    ),
  );

  createEffect(
    on(
      () => ({
        universeId: selectedUniverseId(),
        assignConsoleDmx: state().assignConsoleDmx,
      }),
      ({ universeId, assignConsoleDmx }, prev) => {
        if (!assignConsoleDmx || universeId === null || !prev) {
          return;
        }

        if (prev.universeId !== null && prev.universeId !== universeId) {
          const nextAddress = findNextAvailableAddress(universeId);
          updateState({ startAddress: nextAddress });
        }
      },
      { defer: true },
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
    return address >= 1 && address <= 512;
  });

  createEffect(
    on(
      () => ({
        assignConsoleDmx: state().assignConsoleDmx,
        universeId: state().universeId,
        startAddress: state().startAddress,
        quantity: state().quantity,
        channelCount: channelCount(),
      }),
      (deps) => {
        const {
          assignConsoleDmx,
          universeId,
          startAddress,
          quantity,
          channelCount,
        } = deps;

        if (!assignConsoleDmx) {
          setPatchConflict({ hasConflict: false });
          return;
        }

        if (
          universeId === null ||
          startAddress === null ||
          channelCount === null ||
          quantity < 1
        ) {
          setPatchConflict({ hasConflict: false });
          return;
        }

        const occupied = untrack(() => occupiedConsoleAddresses());

        let absoluteAddress = startAddress;
        for (let fixtureIndex = 0; fixtureIndex < quantity; fixtureIndex += 1) {
          for (
            let channelIndex = 0;
            channelIndex < channelCount;
            channelIndex += 1
          ) {
            const universeOffset = Math.floor((absoluteAddress - 1) / 512);
            const currentUniverse = universeId + universeOffset;
            const addressInUniverse = ((absoluteAddress - 1) % 512) + 1;

            const conflict = occupied.get(
              `${currentUniverse}:${addressInUniverse}`,
            );
            if (conflict) {
              setPatchConflict({
                hasConflict: true,
                conflictingUniverse: currentUniverse,
                conflictingAddress: addressInUniverse,
                conflictingFixtureLabel: conflict.label,
              });
              return;
            }

            absoluteAddress += 1;
          }
        }

        setPatchConflict({ hasConflict: false });
      },
    ),
  );

  const handleUniverseChange = (value: string) => {
    const universeId = Number.parseInt(value, 10);
    if (!Number.isNaN(universeId) && universeId >= 1) {
      updateState({ universeId });
    }
  };

  const handleResetAddress = () => {
    if (!state().assignConsoleDmx) {
      return;
    }

    const ids = universeIds();
    if (ids.length === 0) return;

    const currentUniverse = state().universeId ?? ids[0];
    const nextAddress = findNextAvailableAddress(currentUniverse);
    updateState({ universeId: currentUniverse, startAddress: nextAddress });
  };

  const handleAddressChange = (value: string) => {
    const address = Number.parseInt(value, 10);
    if (!Number.isNaN(address) && address >= 1 && address <= 512) {
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

  const handleAssignConsoleDmxChange = (checked: boolean) => {
    updateState({ assignConsoleDmx: checked });
    if (!checked) {
      setPatchConflict({ hasConflict: false });
    }
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
              max="512"
              aria-label="Start address"
              value={state().startAddress ?? ""}
              onInput={(e) =>
                handleAddressChange((e.target as HTMLInputElement).value)
              }
              class="w-20"
              aria-invalid={!addressValid() || patchConflict().hasConflict}
            />
            <Button
              size="compact"
              type="button"
              onClick={handleResetAddress}
              title="Reset to next available address"
            >
              Auto
            </Button>
          </div>

          <Show when={totalChannelsNeeded() !== null}>
            {(() => {
              const startAddress = state().startAddress ?? 0;
              const totalChannels = totalChannelsNeeded() ?? 0;
              const endAbsolute = startAddress + totalChannels - 1;
              const endUniverseOffset = Math.floor((endAbsolute - 1) / 512);
              const endAddressInUniverse = ((endAbsolute - 1) % 512) + 1;
              const startUniverse = state().universeId ?? 0;
              const endUniverse = startUniverse + endUniverseOffset;
              const spansMultiple = endUniverse > startUniverse;

              return (
                <p class="mt-1 text-sm text-gray-500">
                  {state().quantity} fixture{state().quantity !== 1 ? "s" : ""}{" "}
                  x {channelCount()} ch = {totalChannels} channels (
                  {spansMultiple
                    ? `${startUniverse}.${startAddress}-${endUniverse}.${endAddressInUniverse}`
                    : `${startAddress}-${endAbsolute}`}
                  )
                </p>
              );
            })()}
          </Show>

          <Show when={!addressValid()}>
            <p class="mt-1 text-sm text-red-400">
              Start address must be between 1 and 512
            </p>
          </Show>
          <Show when={patchConflict().hasConflict}>
            <p class="mt-1 text-sm text-red-400">
              <Show
                when={
                  patchConflict().conflictingUniverse !== undefined &&
                  patchConflict().conflictingUniverse !== state().universeId
                }
              >
                Universe {patchConflict().conflictingUniverse}{" "}
              </Show>
              Address {patchConflict().conflictingAddress} conflicts with{" "}
              {patchConflict().conflictingFixtureLabel}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
