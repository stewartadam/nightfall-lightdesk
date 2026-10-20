// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Timebase } from "../../types";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "../ui/segmented-control";

const TIMEBASE_OPTIONS: readonly SegmentedControlOption<Timebase>[] = [
  {
    value: Timebase.Seconds,
    label: "Seconds",
    tooltip: "Times are seconds and run on the clock",
  },
  {
    value: Timebase.Beats,
    label: "Beats",
    tooltip: "Times are beats and follow the show tempo",
  },
];

export interface TimebaseControlProps {
  /** The object's current timebase. */
  value: Timebase;
  /** Called with the timebase the user picks. */
  onChange: (timebase: Timebase) => void;
  class?: string;
}

/**
 * Labelled Timing switch shared by every object that can follow the show tempo. It also tells
 * the user which unit the object's time fields are in.
 */
export function TimebaseControl(props: TimebaseControlProps) {
  return (
    <div
      class={`grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 text-xs ${props.class ?? ""}`}
    >
      <span class="text-neutral-300" aria-hidden="true">
        Timing
      </span>
      <SegmentedControl
        label="Timing"
        density="compact"
        options={TIMEBASE_OPTIONS}
        value={props.value}
        onChange={props.onChange}
        data-testid="timebase-control"
      />
    </div>
  );
}
