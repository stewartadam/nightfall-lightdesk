// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { HandIcon } from "@squidlab/phosphor-solid/hand";
import { onMount } from "solid-js";
import { useUiAction } from "../../../components/providers/command-registry";
import {
  commandFailureMessage,
  commandSucceeded,
} from "../../../lib/command-result";
import { commandClient } from "../../../lib/engine-commands";
import { pushToast } from "../../../state/appStores";

/** Asks the backend to let go of every held Flash and Swop, reporting failures as a toast. */
async function releaseHeldButtons(): Promise<void> {
  try {
    const result = await commandClient.invoke("ControlCommand", {
      type: "ReleaseHeldButtons",
    });
    if (!commandSucceeded(result)) {
      pushToast("error", commandFailureMessage(result));
    }
  } catch (error) {
    pushToast(
      "error",
      error instanceof Error ? error.message : "Could not release held buttons",
    );
  }
}

/**
 * Registers the "Release held buttons" command palette action, which lets go of every held
 * Flash and Swop, such as one left on by a controller that never sent its release.
 */
export function ReleaseHeldButtonsCommand() {
  /** Registers the release action for this mounted application shell. */
  onMount(() => {
    useUiAction({
      id: "controls.release-held-buttons",
      name: "Release held buttons",
      description: "Let go of every held Flash and Swop on the control slots",
      icon: HandIcon,
      execute: () => {
        void releaseHeldButtons();
      },
    });
  });
  return null;
}
