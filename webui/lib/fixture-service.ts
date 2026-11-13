// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types/index";
import type { FixtureLibraryCommand } from "../types/index";
import { commandOutputValue, requireCommandSuccess } from "./command-result";
import { fixtureWireLayout } from "./dmx";
import { commandClient } from "./engine-commands";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

/**
 * Compute the DMX footprint of a fixture, including gaps between explicitly placed channels.
 * This provides a deterministic channel count based on the fixture profile metadata.
 */
export function computeFixtureChannelCount(fixture: types.Fixture): number {
  return fixtureWireLayout(fixture).footprint;
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

  commandClient.emit("FixtureCommand", command, { undoId: batchId });

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

  commandClient.emit("FixtureCommand", command, { undoId: batchId });

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

  commandClient.emit("FixtureCommand", command, { undoId: batchId });

  log.info(`Requested fixture deletion for fixture ${fixtureId}`);
}

/**
 * Request removal of a DMX route, optionally grouped with related undo commands.
 */
export function sendRemoveDmxRoutes(
  source: types.RouteEndpoint,
  target: types.RouteEndpoint,
  priority: number,
  clone: boolean,
  batchId?: string,
) {
  const command: types.FixtureCommand = {
    type: "RemoveDmxRoutes",
    data: {
      source,
      target,
      priority,
      clone,
    },
  };

  commandClient.emit("FixtureCommand", command, { undoId: batchId });

  log.info("Requested DMX route removal");
}

export function sendAddDmxRoute(
  source: types.RouteEndpoint,
  target: types.RouteEndpoint,
  priority: number,
  clone: boolean,
  batchId?: string,
) {
  const command: types.FixtureCommand = {
    type: "AddDmxRoute",
    data: {
      source,
      target,
      priority,
      clone,
    },
  };

  commandClient.emit("FixtureCommand", command, { undoId: batchId });

  log.info("Requested DMX route add");
}

/**
 * Returns the identifier of one library fixture revision. Several revisions
 * of a make/model can coexist, so the revision fingerprint is part of the id.
 */
export function libraryDefinitionId(info: {
  make: string;
  model: string;
  asset_etag: string;
}): string {
  return JSON.stringify([info.make, info.model, info.asset_etag]);
}

/**
 * Returns a short label telling library revisions of one make/model apart: "built-in" for
 * definitions shipped with the app, the GDTF file's revision name, such as "Release 2.0",
 * or else the leading characters of the content fingerprint, like an abbreviated commit hash.
 */
export function libraryRevisionLabel(
  info: Pick<types.AvailableFixtureInfo, "asset_etag" | "gdtf_revision">,
): string {
  if (info.asset_etag.startsWith("builtin:")) return "built-in";
  return info.gdtf_revision || info.asset_etag.slice(0, 8);
}

/**
 * Returns the day a GDTF file's latest revision was made as `YYYY-MM-DD`, which sorts in
 * order as text, the archive's own text when it isn't a date, or "" when it records none.
 */
export function libraryRevisionDate(
  info: Pick<types.AvailableFixtureInfo, "gdtf_revision_date">,
): string {
  const date = info.gdtf_revision_date?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date;
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
  assetEtag?: string,
): Promise<types.CommandResult> {
  const command: FixtureLibraryCommand = {
    type: "CreateFixtureFromLibrary",
    data: {
      id,
      make,
      model,
      mode,
      asset_etag: assetEtag,
      label: label || undefined,
      update_existing_ids: updateExistingIds?.length
        ? updateExistingIds
        : undefined,
      update_existing_only: updateExistingOnly,
    },
  };

  const result = await commandClient.invoke("FixtureLibraryCommand", command);

  log.info(
    `Created fixture from library: ${make} ${model} (${mode}) with ID ${id}`,
  );

  return result;
}

/**
 * Creates several instances of one library fixture mode in a single engine command and
 * waits for completion. The engine converts the profile once and stores either every
 * instance (and requested update) or none, so callers can patch the whole batch after
 * one round trip.
 */
export async function createFixturesFromLibrary(
  make: string,
  model: string,
  mode: string,
  fixtures: types.LibraryFixtureInstance[],
  updateExistingIds?: number[],
  assetEtag?: string,
): Promise<types.CommandResult> {
  const command: FixtureLibraryCommand = {
    type: "CreateFixturesFromLibrary",
    data: {
      make,
      model,
      mode,
      asset_etag: assetEtag,
      fixtures,
      update_existing_ids: updateExistingIds?.length
        ? updateExistingIds
        : undefined,
    },
  };

  const result = await commandClient.invoke("FixtureLibraryCommand", command);

  log.info(
    `Created ${fixtures.length} fixture(s) from library: ${make} ${model} (${mode})`,
  );

  return result;
}

/**
 * Describes one library revision for reviewing an update to it: every mode with the
 * fixture it builds, and the revision notes its GDTF archive records. Rejects with the
 * engine's message when the revision is not in the library.
 */
export async function fetchRevisionDetails(
  make: string,
  model: string,
  assetEtag: string,
): Promise<types.LibraryRevisionDetails> {
  const result = await commandClient.invoke("FixtureLibraryCommand", {
    type: "GetRevisionDetails",
    data: { make, model, asset_etag: assetEtag },
  });
  requireCommandSuccess(result);
  return commandOutputValue(result) as types.LibraryRevisionDetails;
}

/**
 * Moves patched fixtures to another library revision, each rebuilt from the mode named
 * for it, as one undoable engine change. Rejects with the engine's message when the
 * update is refused, in which case no fixture changed.
 */
export async function updateFixturesToRevision(
  make: string,
  model: string,
  assetEtag: string,
  fixtures: types.LibraryFixtureModeUpdate[],
): Promise<void> {
  const result = await commandClient.invoke("FixtureLibraryCommand", {
    type: "UpdateFixturesToRevision",
    data: { make, model, asset_etag: assetEtag, fixtures },
  });
  requireCommandSuccess(result);
  log.info(
    `Updated ${fixtures.length} fixture(s) to library revision: ${make} ${model}`,
  );
}

/**
 * Request fixture profile data from the library.
 * The response will be stored in the fixtureProfile store.
 */
export function fetchFixtureProfile(
  make: string,
  model: string,
  mode?: string,
  assetEtag?: string,
) {
  const command: FixtureLibraryCommand = {
    type: "GetFixtureProfile",
    data: {
      make,
      model,
      mode,
      asset_etag: assetEtag,
    },
  };

  commandClient.emit("FixtureLibraryCommand", command);

  log.info(
    `Requested fixture profile for ${make} ${model}${mode ? ` (${mode})` : ""}`,
  );
}
