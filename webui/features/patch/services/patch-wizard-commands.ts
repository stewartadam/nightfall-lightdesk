// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { v4 as uuidv4 } from "uuid";
import { findFixtureVersionConflictIds } from "../../../lib/asset-version";
import {
  commandSucceeded,
  failedCommandKeys,
  type PendingCommand,
} from "../../../lib/command-result";
import {
  addDmxRoute,
  computeFixtureChannelCount,
  createFixtureFromLibrary,
  createFixturesFromLibrary,
  sendFixturePlacementUpdates,
} from "../../../lib/fixture-service";
import { getLogger } from "../../../lib/logger";
import { isWholeNumberInRange } from "../../../lib/number-draft";
import type * as types from "../../../types";
import {
  type ConsolePatchPlacement,
  layoutConsolePatch,
} from "../model/console-patch-allocation";
import { buildSequentialFixturePlacementUpdates } from "../model/fixture-insert-placement";
import {
  MAX_PATCH_QUANTITY,
  validConsolePatchStart,
} from "../model/patch-wizard-fields";
import type { PatchWizardState } from "../wizard/wizard-context";

const log = getLogger(import.meta.url);

/**
 * Sends one console DMX route per new fixture, all in the same undo group, without waiting, so
 * the routes reach the backend in order before anything else is sent.
 */
function sendConsoleRoutes(
  fixtureIds: number[],
  placements: ConsolePatchPlacement[],
  batchId: string,
): PendingCommand<number>[] {
  return fixtureIds.map((fixtureId, index) => {
    const { universe, address } = placements[index];
    return {
      key: fixtureId,
      result: addDmxRoute(
        { type: "Fixture", data: { ids: [fixtureId] } },
        {
          type: "Console",
          data: { universe: { start: universe, end: universe }, address },
        },
        0,
        false,
        batchId,
      ),
    };
  });
}

export type PatchWizardCommandResult =
  /** Fixtures were created; `unpatchedFixtureIds` lists those whose DMX route was rejected. */
  | { status: "success"; unpatchedFixtureIds: number[] }
  | { status: "conflict"; fixtureIds: number[] }
  | { status: "failed" };

export type PatchWizardCommandOptions = {
  state: PatchWizardState;
  fixtures: Record<string, types.Fixture>;
  profileFixture: types.Fixture;
  libraryFixtureInfo: types.AvailableFixtureInfo;
  geometry: types.FixtureGeometry | null;
  baseFixtureId: number;
  forceUpdateExisting?: boolean;
};

/**
 * Creates or morphs fixtures and applies the wizard's patch and placement commands.
 *
 * New fixtures are created by one atomic batch command, so a failure leaves the show
 * unchanged. The follow-up DMX routes and placements share one undo group.
 */
export async function executePatchWizardCommands(
  options: PatchWizardCommandOptions,
): Promise<PatchWizardCommandResult> {
  const { state } = options;
  if (!state.fixtureDefinitionId || !state.fixtureMode) {
    log.error("Cannot finish: missing fixture definition or mode");
    return { status: "failed" };
  }

  const { make, model, asset_etag: assetEtag } = options.libraryFixtureInfo;
  const isMorphMode = state.morphFixtureIds.length > 0;
  const versionConflictIds = isMorphMode
    ? []
    : findFixtureVersionConflictIds(
        options.fixtures,
        options.profileFixture,
        options.libraryFixtureInfo.asset_etag,
      );
  if (versionConflictIds.length > 0 && !options.forceUpdateExisting) {
    return { status: "conflict", fixtureIds: versionConflictIds };
  }

  const updateExistingIds = options.forceUpdateExisting
    ? versionConflictIds
    : [];

  try {
    if (isMorphMode) {
      const result = await createFixtureFromLibrary(
        state.morphFixtureIds[0],
        make,
        model,
        state.fixtureMode,
        undefined,
        state.morphFixtureIds,
        true,
        assetEtag,
      );
      if (!commandSucceeded(result)) {
        log.error("Failed to morph fixtures:", result.outcome);
        return { status: "failed" };
      }
      log.info(
        `Morphed ${state.morphFixtureIds.length} fixture(s) to ${make} ${model} (${state.fixtureMode})`,
      );
      return { status: "success", unpatchedFixtureIds: [] };
    }

    const { quantity } = state;
    if (!isWholeNumberInRange(quantity, 1, MAX_PATCH_QUANTITY)) {
      log.error("Cannot finish: invalid fixture quantity", { quantity });
      return { status: "failed" };
    }
    const instances: types.LibraryFixtureInstance[] = Array.from(
      { length: quantity },
      (_, index) => ({
        id: options.baseFixtureId + index,
        label: state.label
          ? quantity > 1
            ? `${state.label} ${index + 1}`
            : state.label
          : undefined,
      }),
    );
    const result = await createFixturesFromLibrary(
      make,
      model,
      state.fixtureMode,
      instances,
      updateExistingIds,
      assetEtag,
    );
    if (!commandSucceeded(result)) {
      log.error("Failed to create fixtures:", result.outcome);
      return { status: "failed" };
    }

    const batchId = uuidv4().replace(/-/g, "");
    const consoleStart = state.assignConsoleDmx
      ? validConsolePatchStart(state)
      : null;
    const routeResults = consoleStart
      ? sendConsoleRoutes(
          instances.map(({ id }) => id),
          layoutConsolePatch(
            consoleStart,
            Math.max(computeFixtureChannelCount(options.profileFixture), 1),
            instances.length,
          ),
          batchId,
        )
      : [];

    sendFixturePlacementUpdates(
      buildSequentialFixturePlacementUpdates(
        instances.map(({ id }) => id),
        options.geometry,
      ),
      batchId,
    );

    // Each rejection's reason is already shown by the shared command failure toast.
    const unpatchedFixtureIds = await failedCommandKeys(routeResults);
    if (unpatchedFixtureIds.length > 0) {
      log.warn("Some new fixtures could not be patched", {
        unpatchedFixtureIds,
      });
    }
    log.info(
      `Created ${instances.length} fixture(s): ${make} ${model} (${state.fixtureMode})`,
    );
    return { status: "success", unpatchedFixtureIds };
  } catch (error) {
    log.error("Failed to create fixtures:", String(error));
    return { status: "failed" };
  }
}
