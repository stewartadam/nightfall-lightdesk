// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowLeftIcon } from "@squidlab/phosphor-solid/arrow-left";
import { ArrowRightIcon } from "@squidlab/phosphor-solid/arrow-right";
import { ArrowsLeftRightIcon } from "@squidlab/phosphor-solid/arrows-left-right";
import Tooltip from "../../../../components/ui/tooltip";
import { FxDirection } from "../../../../types";

/** Renders icon radio buttons for the effect-wide traversal direction. */
export function StepFxDirectionControl(props: {
  direction: FxDirection;
  onChange: (direction: FxDirection) => void;
}) {
  const directionButtonClass =
    "inline-flex size-8 items-center justify-center border border-neutral-700 text-neutral-300 transition-colors hover:bg-neutral-700 aria-checked:bg-blue-600 aria-checked:text-white";

  return (
    <div
      class="inline-flex shrink-0 items-center"
      role="radiogroup"
      aria-label="Step FX direction"
    >
      <Tooltip content={() => "Reverse"}>
        <button
          type="button"
          role="radio"
          aria-label="Reverse direction"
          aria-checked={props.direction === FxDirection.Reverse}
          class={`${directionButtonClass} rounded-l`}
          onClick={() => props.onChange(FxDirection.Reverse)}
        >
          <ArrowLeftIcon class="size-4" aria-hidden />
        </button>
      </Tooltip>
      <Tooltip content={() => "Bounce"}>
        <button
          type="button"
          role="radio"
          aria-label="Bounce direction"
          aria-checked={props.direction === FxDirection.Bounce}
          class={`${directionButtonClass} border-x-0`}
          onClick={() => props.onChange(FxDirection.Bounce)}
        >
          <ArrowsLeftRightIcon class="size-4" aria-hidden />
        </button>
      </Tooltip>
      <Tooltip content={() => "Forward"}>
        <button
          type="button"
          role="radio"
          aria-label="Forward direction"
          aria-checked={props.direction === FxDirection.Forward}
          class={`${directionButtonClass} rounded-r`}
          onClick={() => props.onChange(FxDirection.Forward)}
        >
          <ArrowRightIcon class="size-4" aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}
