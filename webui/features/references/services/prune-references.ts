// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { commandSucceeded } from "../../../lib/command-result";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { pushToast } from "../../../state/appStores";

const log = getLogger(import.meta.url);

/**
 * Asks the backend to remove every resolved fixture reference whose fixture or element no longer
 * exists, as one undo step, and reports how many it removed.
 */
export async function pruneMissingFixtureReferences(
  prunableCount: number,
): Promise<void> {
  try {
    const result = await engineRuntime.sendCommandAndAwait({
      module: "ReferenceCommand",
      command: { type: "PruneMissingFixtureRefs" },
    });
    // The engine runtime already shows failures as toasts.
    if (!commandSucceeded(result)) return;
    pushToast(
      "success",
      `Pruned ${prunableCount} missing fixture reference(s).`,
    );
  } catch (error) {
    log.error("Failed to prune missing fixture references", { error });
    pushToast("error", "Prune failed: not connected to the engine.");
  }
}
