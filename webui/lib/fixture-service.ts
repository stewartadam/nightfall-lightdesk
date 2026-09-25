// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FixtureLibraryCommand } from "../types/index";
import * as types from "../types/index";
import { normalizeFixtureUid } from "./binding-utils";
import { commandEnvelope } from "./command-envelope";
import { getResolutionChannelWidth } from "./dmx";
import { engineRuntime } from "./engine-runtime";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

/** Converts a physical input transport to the command endpoint target ID. */
function bindingTransportToTargetId(transport: types.BindingTransport): string {
  if (transport === types.BindingTransport.ArtNet) return "artnet";
  return transport;
}

/**
 * Compute the total DMX channel count for a fixture from its elements and parameters.
 * This provides a deterministic channel count based on the fixture profile metadata.
 */
export function computeFixtureChannelCount(fixture: types.Fixture): number {
  let total = 0;
  for (const element of fixture.elements) {
    for (const param of element.parameters) {
      // Skip virtual parameters that don't occupy DMX channels
      if (param.attribute.type === "VirtualIntensity") continue;
      total += getResolutionChannelWidth(param.resolution);
    }
  }
  return total;
}

export function sendFixturePlacementUpdate(
  fixtureId: number,
  position?: types.FixturePlacementPositionUpdate,
  rotation?: types.FixturePlacementRotationUpdate,
  batchId?: string,
) {
  sendFixturePlacementUpdates(
    [
      {
        id: fixtureId,
        position,
        rotation,
      },
    ],
    batchId,
  );
}

export function sendFixturePlacementUpdates(
  updates: types.FixturePlacementUpdateEntry[],
  batchId?: string,
) {
  if (updates.length === 0) {
    return;
  }

  const command: types.FixtureCommand = {
    type: "UpdateFixturePlacements",
    data: {
      updates,
    },
  };

  engineRuntime.sendCommand(
    commandEnvelope("FixtureCommand", command, batchId),
  );

  log.info(`Updated placement for ${updates.length} fixtures`);
}

/** Assigns or clears the default color path used by fixture color cues. */
export function sendFixtureColorPathDefault(
  fixture: types.FixtureRef,
  colorPathId: number | undefined,
  batchId?: string,
) {
  const command: types.FixtureCommand = {
    type: "SetColorPathDefault",
    data: {
      fixture,
      color_path_id: colorPathId,
    },
  };

  engineRuntime.sendCommand(
    commandEnvelope("FixtureCommand", command, batchId),
  );

  log.info(
    colorPathId === undefined
      ? `Cleared color path default for fixture ${fixture.fixture_uid}`
      : `Set color path default ${colorPathId} for fixture ${fixture.fixture_uid}`,
  );
}
/**
 * Request deletion of a fixture, optionally grouped with related undo commands.
 */
export function sendDeleteFixture(fixtureId: number, batchId?: string) {
  const command: types.FixtureCommand = {
    type: "DeleteFixture",
    data: fixtureId,
  };

  engineRuntime.sendCommand(
    commandEnvelope("FixtureCommand", command, batchId),
  );

  log.info(`Requested fixture deletion for fixture ${fixtureId}`);
}

/**
 * Request removal of a patch binding, optionally grouped with related undo commands.
 */
export function sendRemovePatchBinding(
  source: types.BindingEndpoint,
  target: types.BindingEndpoint,
  priority: number,
  clone: boolean,
  batchId?: string,
) {
  const command: types.FixtureCommand = {
    type: "RemovePatchBinding",
    data: {
      source,
      target,
      priority,
      clone,
    },
  };

  engineRuntime.sendCommand(
    commandEnvelope("FixtureCommand", command, batchId),
  );

  log.info("Requested patch binding removal");
}

export function sendAddPatchBinding(
  source: types.BindingEndpoint,
  target: types.BindingEndpoint,
  priority: number,
  clone: boolean,
  batchId?: string,
) {
  const command: types.FixtureCommand = {
    type: "PatchBinding",
    data: {
      source,
      target,
      priority,
      clone,
    },
  };

  engineRuntime.sendCommand(
    commandEnvelope("FixtureCommand", command, batchId),
  );

  log.info("Requested patch binding add");
}

/**
 * Converts fixture UIDs to fixture IDs, returning null if any UID is unresolved.
 */
function toFixtureIds(
  uids: types.Uuid[],
  fixtureMap: Record<string, types.Fixture>,
): number[] | null {
  if (uids.length === 0) {
    return null;
  }

  const ids: number[] = [];
  for (const uid of uids) {
    const fixture = fixtureMap[normalizeFixtureUid(uid)];
    if (!fixture) {
      return null;
    }
    ids.push(fixture.identifiers.id);
  }

  return ids;
}

function toInputSourceEndpoint(
  source: types.InputSource,
  fixtureMap: Record<string, types.Fixture>,
): types.BindingEndpoint | null {
  switch (source.type) {
    case "Transport":
      return {
        type: "Transport",
        data: {
          target: bindingTransportToTargetId(source.data.transport),
          universe: source.data.universe,
          address: source.data.address,
        },
      };
    case "Console":
      return { type: "Console", data: { ...source.data } };
    case "Fixture": {
      const ids = toFixtureIds(source.data.uids, fixtureMap);
      if (!ids) return null;
      return {
        type: "Fixture",
        data: {
          ids,
          element: source.data.element,
          param: source.data.param,
        },
      };
    }
  }
}

function toInputTargetEndpoint(
  target: types.InputTarget,
  fixtureMap: Record<string, types.Fixture>,
): types.BindingEndpoint | null {
  switch (target.type) {
    case "Transport":
      return { type: "Transport", data: { ...target.data } };
    case "Console":
      return { type: "Console", data: { ...target.data } };
    case "Fixture": {
      const ids = toFixtureIds(target.data.uids, fixtureMap);
      if (!ids) return null;
      return {
        type: "Fixture",
        data: {
          ids,
          element: target.data.element,
          param: target.data.param,
        },
      };
    }
    case "Disabled":
      return { type: "Disabled" };
  }
}

function toOutputSourceEndpoint(
  source: types.OutputSource,
  fixtureMap: Record<string, types.Fixture>,
): types.BindingEndpoint | null {
  switch (source.type) {
    case "Console":
      return { type: "Console", data: { ...source.data } };
    case "Fixture": {
      const ids = toFixtureIds(source.data.uids, fixtureMap);
      if (!ids) return null;
      return {
        type: "Fixture",
        data: {
          ids,
          element: source.data.element,
          param: source.data.param,
        },
      };
    }
  }
}

function toOutputTargetEndpoint(
  target: types.OutputTarget,
): types.BindingEndpoint {
  switch (target.type) {
    case "Transport":
      return { type: "Transport", data: { ...target.data } };
    case "Console":
      return { type: "Console", data: { ...target.data } };
    case "Disabled":
      return { type: "Disabled" };
  }
}

/**
 * Checks whether a fixture binding endpoint references any selected fixture ID.
 */
function endpointHasAnyFixtureId(
  endpoint: types.BindingEndpoint | null,
  fixtureIds: ReadonlySet<number>,
): boolean {
  if (endpoint?.type !== "Fixture") {
    return false;
  }
  return endpoint.data.ids.some((id) => fixtureIds.has(id));
}

/**
 * Remove every patch binding that references any of the provided fixture IDs.
 * Returns the number of remove commands dispatched.
 */
export function removePatchBindingsForFixtureIds(
  fixtureIds: readonly number[],
  snapshot: types.BindingsSnapshot,
  fixtureMap: Record<string, types.Fixture>,
  batchId?: string,
): number {
  if (fixtureIds.length === 0) {
    return 0;
  }

  const fixtureIdSet = new Set(fixtureIds);
  let removedCount = 0;

  for (const binding of snapshot.input ?? []) {
    const sourceEndpoint = toInputSourceEndpoint(binding.source, fixtureMap);
    const targetEndpoint = toInputTargetEndpoint(binding.target, fixtureMap);
    const matches =
      endpointHasAnyFixtureId(sourceEndpoint, fixtureIdSet) ||
      endpointHasAnyFixtureId(targetEndpoint, fixtureIdSet);
    if (!matches || !sourceEndpoint || !targetEndpoint) {
      continue;
    }

    sendRemovePatchBinding(
      sourceEndpoint,
      targetEndpoint,
      binding.priority,
      binding.clone,
      batchId,
    );
    removedCount += 1;
  }

  for (const binding of snapshot.output ?? []) {
    const sourceEndpoint = toOutputSourceEndpoint(binding.source, fixtureMap);
    const targetEndpoint = toOutputTargetEndpoint(binding.target);
    const matches = endpointHasAnyFixtureId(sourceEndpoint, fixtureIdSet);
    if (!matches || !sourceEndpoint) {
      continue;
    }

    sendRemovePatchBinding(
      sourceEndpoint,
      targetEndpoint,
      binding.priority,
      binding.clone,
      batchId,
    );
    removedCount += 1;
  }

  for (const binding of snapshot.disabled ?? []) {
    if (binding.type === "Input") {
      const sourceEndpoint = toInputSourceEndpoint(
        binding.data.source,
        fixtureMap,
      );
      const matches = endpointHasAnyFixtureId(sourceEndpoint, fixtureIdSet);
      if (!matches || !sourceEndpoint) {
        continue;
      }

      sendRemovePatchBinding(
        sourceEndpoint,
        { type: "Disabled" },
        binding.data.priority,
        binding.data.clone,
        batchId,
      );
      removedCount += 1;
      continue;
    }

    const sourceEndpoint = toOutputSourceEndpoint(
      binding.data.source,
      fixtureMap,
    );
    const matches = endpointHasAnyFixtureId(sourceEndpoint, fixtureIdSet);
    if (!matches || !sourceEndpoint) {
      continue;
    }

    sendRemovePatchBinding(
      sourceEndpoint,
      { type: "Disabled" },
      binding.data.priority,
      binding.data.clone,
      batchId,
    );
    removedCount += 1;
  }

  if (removedCount > 0) {
    log.info(
      `Requested removal of ${removedCount} patch binding(s) for fixtures ${fixtureIds.join(", ")}`,
    );
  }

  return removedCount;
}

/**
 * Create a fixture from the library and wait for completion.
 * Returns a promise that resolves when the fixture is created.
 * Use this when you need to perform follow-up operations like patching.
 */
export async function createFixtureFromLibrary(
  id: number,
  make: string,
  model: string,
  mode: string,
  label?: string,
  updateExistingIds?: number[],
  updateExistingOnly = false,
): Promise<types.CommandResult> {
  const command: FixtureLibraryCommand = {
    type: "CreateFixtureFromLibrary",
    data: {
      id,
      make,
      model,
      mode,
      label: label || undefined,
      update_existing_ids: updateExistingIds?.length
        ? updateExistingIds
        : undefined,
      update_existing_only: updateExistingOnly,
    },
  };

  const result = await engineRuntime.sendCommandAndAwait({
    module: "FixtureLibraryCommand",
    command,
  });

  log.info(
    `Created fixture from library: ${make} ${model} (${mode}) with ID ${id}`,
  );

  return result;
}

/**
 * Creates several instances of one library fixture mode in a single engine command and
 * waits for completion. The engine converts the profile once and stores either every
 * instance or none, so callers can patch the whole batch after one round trip.
 */
export async function createFixturesFromLibrary(
  make: string,
  model: string,
  mode: string,
  fixtures: types.LibraryFixtureInstance[],
  updateExistingIds?: number[],
): Promise<types.CommandResult> {
  const command: FixtureLibraryCommand = {
    type: "CreateFixturesFromLibrary",
    data: {
      make,
      model,
      mode,
      fixtures,
      update_existing_ids: updateExistingIds?.length
        ? updateExistingIds
        : undefined,
    },
  };

  const result = await engineRuntime.sendCommandAndAwait({
    module: "FixtureLibraryCommand",
    command,
  });

  log.info(
    `Created ${fixtures.length} fixture(s) from library: ${make} ${model} (${mode})`,
  );

  return result;
}

/**
 * Request fixture profile data from the library.
 * The response will be stored in the fixtureProfile store.
 */
export function fetchFixtureProfile(
  make: string,
  model: string,
  mode?: string,
) {
  const command: FixtureLibraryCommand = {
    type: "GetFixtureProfile",
    data: {
      make,
      model,
      mode,
    },
  };

  engineRuntime.sendCommand({
    module: "FixtureLibraryCommand",
    command,
  });

  log.info(
    `Requested fixture profile for ${make} ${model}${mode ? ` (${mode})` : ""}`,
  );
}
