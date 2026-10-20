// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { DropdownMenu } from "../../../../components/ui/dropdown-menu";
import { Checkbox, Input } from "../../../../components/ui/form-controls";
import type * as types from "../../../../types";
import {
  stepFxBeatValue,
  stepFxTimingFromBeat,
} from "../../model/step-fx-editor-model";
import { StepFxPhaseField } from "../step-fx-phase-field";
import { STEP_FX_FIELD_CLASS } from "./step-fx-editor-styles";

/** Renders lane-specific overrides at the end of the attribute Step bar. */
export function StepFxOverridesControl(props: {
  lane: types.FxLane;
  overall: types.StepFx;
  open: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onLaneChange: (lane: types.FxLane) => void;
}) {
  return (
    <div class="flex shrink-0 items-center gap-1">
      <DropdownMenu
        placement="below"
        align="end"
        triggerLabel="Overrides"
        open={props.open}
        onOpenChange={props.onOpenChange}
        triggerSize="compact"
        trigger={
          <>
            Overrides
            <CaretDownIcon class="size-3" aria-hidden />
          </>
        }
      >
        <div
          class="w-80 p-2"
          role="region"
          aria-label="Overrides"
          data-menu-kind="step-fx-overrides"
        >
          <AdvancedLaneControls
            lane={props.lane}
            overall={props.overall}
            onChange={props.onLaneChange}
          />
        </div>
      </DropdownMenu>
    </div>
  );
}

/** Edits optional timing and phase overrides for the active lane. */
function AdvancedLaneControls(props: {
  lane: types.FxLane;
  overall: types.StepFx;
  onChange: (lane: types.FxLane) => void;
}) {
  /** Publishes an independently cloned lane update. */
  const update = (edit: (lane: types.FxLane) => void): void => {
    const lane = structuredClone(props.lane);
    edit(lane);
    props.onChange(lane);
  };
  return (
    <div class="space-y-1 text-xs">
      <div
        class="grid grid-cols-[minmax(0,1fr)_8.5rem] items-center gap-2 rounded px-1 py-1"
        data-step-fx-lane-override="beat"
        role="group"
        aria-label="Beat override"
      >
        <label class="flex min-w-0 items-center gap-2 text-neutral-200">
          <Checkbox
            checked={Boolean(props.lane.timing_override)}
            onChange={(event) =>
              update(
                (lane) =>
                  (lane.timing_override = event.currentTarget.checked
                    ? structuredClone(props.overall.timing)
                    : undefined),
              )
            }
          />
          <span class="whitespace-nowrap">Override beat</span>
        </label>
        <Input
          density="compact"
          aria-label="Lane BPM"
          type="number"
          min="0.001"
          disabled={!props.lane.timing_override}
          class={`${STEP_FX_FIELD_CLASS} w-full min-w-0`}
          value={stepFxBeatValue(
            props.lane.timing_override ?? props.overall.timing,
            "BPM",
          )}
          onChange={(event) => {
            const next = stepFxTimingFromBeat(
              Number(event.currentTarget.value),
              "BPM",
            );
            if (next) update((lane) => (lane.timing_override = next));
          }}
        />
      </div>
      <div
        class="grid grid-cols-[minmax(0,1fr)_8.5rem] items-start gap-2 rounded px-1 py-1"
        data-step-fx-lane-override="start-position"
        role="group"
        aria-label="Start position override"
      >
        <label class="flex min-w-0 items-center gap-2 pt-2 text-neutral-200">
          <Checkbox
            checked={Boolean(props.lane.phase_override)}
            onChange={(event) =>
              update(
                (lane) =>
                  (lane.phase_override = event.currentTarget.checked
                    ? structuredClone(props.overall.phase)
                    : undefined),
              )
            }
          />
          <span class="whitespace-nowrap">Override start position</span>
        </label>
        <StepFxPhaseField
          ariaLabel="Lane start position"
          phase={props.lane.phase_override ?? props.overall.phase}
          disabled={!props.lane.phase_override}
          onChange={(nextPhase) =>
            update((lane) => (lane.phase_override = nextPhase))
          }
        />
      </div>
    </div>
  );
}
