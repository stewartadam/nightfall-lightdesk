// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { engineRuntime } from "../../../lib/engine-runtime";
import { storeStepFx } from "../../../lib/fx-service";
import { getLogger } from "../../../lib/logger";
import {
  pruneMissingSelectionReferences,
  type ReferenceAuditInputs,
} from "../../../lib/reference-audit";
import { pushToast } from "../../../state/appStores";
import type * as types from "../../../types";

const log = getLogger(import.meta.url);

/** Prunes repairable missing selections through their owning command modules. */
export function pruneReferenceSelections(input: ReferenceAuditInputs): void {
  const prune = pruneMissingSelectionReferences(input);
  if (prune.prunedReferenceCount === 0) {
    pushToast("info", "No prunable references found.");
    return;
  }

  for (const group of prune.groups) {
    const command: types.GroupCommand = { type: "StoreGroup", data: group };
    engineRuntime.sendCommand({ module: "GroupCommand", command });
  }
  for (const cue of prune.cues) {
    const command: types.CueCommand = { type: "StoreCue", data: cue };
    engineRuntime.sendCommand({ module: "CueCommand", command });
  }
  for (const fx of prune.fx) {
    const command: types.FxCommand = { type: "StoreFx", data: fx };
    engineRuntime.sendCommand({ module: "FxCommand", command });
  }
  for (const stepFx of prune.stepFx) {
    storeStepFx(stepFx);
  }
  for (const fxModule of prune.fxModules) {
    const command: types.FxModuleCommand = {
      type: "StoreFxModule",
      data: {
        identifiers: fxModule.identifiers,
        module_name: fxModule.module_name,
        selection: fxModule.selection,
        config: fxModule.config,
        merge: false,
      },
    };
    engineRuntime.sendCommand({ module: "FxModuleCommand", command });
  }
  for (const flow of prune.flows) {
    const command: types.FlowCommand = { type: "StoreFlow", data: flow };
    engineRuntime.sendCommand({ module: "FlowCommand", command });
  }

  log.info("Pruned missing selection references", prune);
  pushToast(
    "success",
    `Pruned ${prune.prunedReferenceCount} missing selection reference(s).`,
  );
}
