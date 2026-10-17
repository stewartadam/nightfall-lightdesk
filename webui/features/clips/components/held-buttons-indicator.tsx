// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { HandIcon } from "@squidlab/phosphor-solid/hand";
import { createMemo, type JSX, onMount, Show } from "solid-js";
import { useUiAction } from "../../../components/providers/command-registry";
import Tooltip from "../../../components/ui/tooltip";
import { CommandClient } from "../../../lib/command-client";
import {
  commandFailureMessage,
  commandSucceeded,
} from "../../../lib/command-result";
import { engineRuntime } from "../../../lib/engine-runtime";
import { controls, pushToast } from "../../../state/appStores";
import { ControlButtonMode } from "../../../types";

const commandClient = new CommandClient(engineRuntime);

/** Asks the backend to let go of every held Flash and Swop, reporting failures as a toast. */
async function releaseHeldButtons(): Promise<void> {
  try {
    const result = await commandClient.submitCommand("ControlCommand", {
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
 * Shows which control slots hold a Flash or Swop down, so a press left on by a stuck
 * controller can never silently change the output, and lets go of all of them when clicked.
 * Also registers the "Release held buttons" command palette action.
 */
export function HeldButtonsIndicator(): JSX.Element {
  const $controls = useStore(controls);

  /** Slots a Flash or Swop is held on, in slot order. */
  const held = createMemo(() =>
    $controls()
      .filter((control) => control.is_flashing)
      .sort((left, right) => left.index - right.index),
  );

  /** Short status text naming what is held, such as "Swop held: 3 · Flash held: 1, 2". */
  const label = createMemo(() =>
    [ControlButtonMode.Swop, ControlButtonMode.Flash]
      .map((mode) => {
        const slots = held().filter((control) => control.button_mode === mode);
        return slots.length > 0
          ? `${mode} held: ${slots.map((slot) => slot.index).join(", ")}`
          : undefined;
      })
      .filter((part) => part !== undefined)
      .join(" · "),
  );

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

  return (
    <Show when={held().length > 0}>
      <Tooltip content={() => "Release every held Flash and Swop"}>
        <button
          type="button"
          data-testid="held-buttons-indicator"
          class="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 font-medium text-amber-300 hover:bg-amber-500/30"
          onClick={() => void releaseHeldButtons()}
        >
          <HandIcon class="size-3.5 shrink-0" aria-hidden />
          {label()}
        </button>
      </Tooltip>
    </Show>
  );
}
