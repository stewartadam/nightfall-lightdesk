// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { findFixtureVersionConflictIds } from "../../../lib/asset-version";
import { commandSucceeded } from "../../../lib/command-result";
import {
  createFixtureFromLibrary,
  sendAddPatchBinding,
  sendFixturePlacementUpdates,
} from "../../../lib/fixture-service";
import { getLogger } from "../../../lib/logger";
import type * as types from "../../../types";
import { buildSequentialFixturePlacementUpdates } from "../model/fixture-insert-placement";
import type { PatchWizardState } from "../wizard/wizard-context";

const log = getLogger(import.meta.url);

export type PatchWizardCommandResult =
  | { status: "success" }
  | { status: "conflict"; fixtureIds: number[] }
  | { status: "failed" };

export type PatchWizardCommandOptions = {
  state: PatchWizardState;
  fixtures: Record<string, types.Fixture>;
  profileFixture: types.Fixture;
  libraryFixtureInfo: types.AvailableFixtureInfo;
  geometry: types.FixtureGeometry | null;
  baseFixtureId: number;
  channelCount: number;
  forceUpdateExisting?: boolean;
};

/** Creates or morphs fixtures and applies the wizard's patch and placement commands. */
export async function executePatchWizardCommands(
  options: PatchWizardCommandOptions,
): Promise<PatchWizardCommandResult> {
  const { state } = options;
  if (!state.fixtureDefinitionId || !state.fixtureMode) {
    log.error("Cannot finish: missing fixture definition or mode");
    return { status: "failed" };
  }

  const [make, model] = state.fixtureDefinitionId.split(":");
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
  const createdFixtureIds: number[] = [];

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
      );
      if (!commandSucceeded(result)) {
        log.error("Failed to morph fixtures:", result.outcome);
        return { status: "failed" };
      }
      log.info(
        `Morphed ${state.morphFixtureIds.length} fixture(s) to ${make} ${model} (${state.fixtureMode})`,
      );
      return { status: "success" };
    }

    for (let index = 0; index < state.quantity; index++) {
      const fixtureId = options.baseFixtureId + index;
      const label = state.label
        ? state.quantity > 1
          ? `${state.label} ${index + 1}`
          : state.label
        : undefined;
      const result = await createFixtureFromLibrary(
        fixtureId,
        make,
        model,
        state.fixtureMode,
        label,
        index === 0 ? updateExistingIds : undefined,
      );
      if (commandSucceeded(result)) {
        createdFixtureIds.push(fixtureId);
      }

      if (
        commandSucceeded(result) &&
        state.assignConsoleDmx &&
        state.universeId !== null &&
        state.startAddress !== null
      ) {
        const absoluteAddress =
          state.startAddress + index * options.channelCount;
        const universeOffset = Math.floor((absoluteAddress - 1) / 512);
        sendAddPatchBinding(
          { type: "Fixture", data: { ids: [fixtureId] } },
          {
            type: "Console",
            data: {
              universe: {
                start: state.universeId + universeOffset,
                end: state.universeId + universeOffset,
              },
              address: ((absoluteAddress - 1) % 512) + 1,
            },
          },
          0,
          false,
        );
      }
    }

    sendFixturePlacementUpdates(
      buildSequentialFixturePlacementUpdates(
        createdFixtureIds,
        options.geometry,
      ),
    );
    log.info(
      `Created ${state.quantity} fixture(s): ${make} ${model} (${state.fixtureMode})`,
    );
    return { status: "success" };
  } catch (error) {
    log.error("Failed to create fixtures:", String(error));
    return { status: "failed" };
  }
}
