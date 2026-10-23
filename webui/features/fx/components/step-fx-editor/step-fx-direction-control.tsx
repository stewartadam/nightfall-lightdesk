// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowLeftIcon } from "@squidlab/phosphor-solid/arrow-left";
import { ArrowRightIcon } from "@squidlab/phosphor-solid/arrow-right";
import { ArrowsLeftRightIcon } from "@squidlab/phosphor-solid/arrows-left-right";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "../../../../components/ui/segmented-control";
import { FxDirection } from "../../../../types";

const DIRECTION_OPTIONS: readonly SegmentedControlOption<FxDirection>[] = [
  {
    value: FxDirection.Reverse,
    icon: ArrowLeftIcon,
    ariaLabel: "Reverse direction",
    tooltip: "Reverse",
  },
  {
    value: FxDirection.Bounce,
    icon: ArrowsLeftRightIcon,
    ariaLabel: "Bounce direction",
    tooltip: "Bounce",
  },
  {
    value: FxDirection.Forward,
    icon: ArrowRightIcon,
    ariaLabel: "Forward direction",
    tooltip: "Forward",
  },
];

/** Renders icon radio buttons for the effect-wide traversal direction. */
export function StepFxDirectionControl(props: {
  direction: FxDirection;
  onChange: (direction: FxDirection) => void;
}) {
  return (
    <SegmentedControl
      label="Step FX direction"
      options={DIRECTION_OPTIONS}
      value={props.direction}
      onChange={props.onChange}
    />
  );
}
