// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { createEffect, createSignal, Show } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuSeparator,
} from "../../../../components/ui/dropdown-menu";
import { Input, NativeSelect } from "../../../../components/ui/form-controls";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "../../../../components/ui/segmented-control";
import { TimebaseControl } from "../../../../components/widgets/timebase-control";
import type * as types from "../../../../types";
import { Timebase } from "../../../../types";
import {
  type StepFxBeatUnit,
  type StepFxTrackKind,
  stepFxBeatValue,
  stepFxTimingFromBeat,
} from "../../model/step-fx-editor-model";
import { STEP_FX_FIELD_CLASS } from "./step-fx-editor-styles";

const CYCLE_SCALE_OPTIONS: readonly SegmentedControlOption<
  types.StepFxCycleScale["type"]
>[] = [
  { value: "Auto", label: "Auto", ariaLabel: "Automatic cycle scaling" },
  { value: "Fixed", label: "Fixed", ariaLabel: "Fixed cycle scaling" },
];

/** Renders compact effect-wide beat timing and cycle scaling in a toolbar menu. */
export function StepFxTimingControls(props: {
  stepFx: types.StepFx;
  open: boolean;
  onOpenChange: (isOpen: boolean) => void;
  beatUnit: StepFxBeatUnit;
  cycleBeatText: string | null;
  fixedScaleDefault: number;
  trackKind: StepFxTrackKind;
  beatError?: string;
  scaleError?: string;
  onBeatUnitChange: (unit: StepFxBeatUnit) => void;
  onTimingChange: (timing: types.StepFxTiming) => void;
  onTimebaseChange: (timebase: types.Timebase) => void;
  onCycleScaleChange: (scale: types.StepFxCycleScale) => void;
}) {
  const followsTempo = () => props.stepFx.timebase === Timebase.Beats;
  const [fixedScaleValue, setFixedScaleValue] = createSignal(
    props.stepFx.cycle_scale.type === "Fixed"
      ? props.stepFx.cycle_scale.data
      : props.fixedScaleDefault,
  );

  /** Retains externally authored fixed values without clearing them in Auto mode. */
  createEffect(() => {
    const scale = props.stepFx.cycle_scale;
    if (scale.type === "Fixed") setFixedScaleValue(scale.data);
  });

  return (
    <DropdownMenu
      placement="below"
      align="start"
      triggerLabel="Timing and scaling"
      open={props.open}
      onOpenChange={props.onOpenChange}
      triggerSize="compact"
      trigger={
        <span class="inline-flex items-center gap-1.5 tabular-nums">
          <Show when={!followsTempo()} fallback={<>Show tempo </>}>
            {stepFxBeatValue(props.stepFx.timing, props.beatUnit)}{" "}
            {props.beatUnit}{" "}
          </Show>
          <span class="text-neutral-400">
            · {props.stepFx.cycle_scale.type}
          </span>
          <CaretDownIcon class="size-3" aria-hidden />
        </span>
      }
    >
      <div class="w-80 py-1" data-menu-kind="step-fx-timing">
        <div class="px-3 py-2">
          <div class="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Timing and scaling
          </div>
          <div class="text-xs text-neutral-500">Effect-wide cycle timing</div>
        </div>
        <DropdownMenuSeparator />
        <div class="space-y-3 px-3 py-2">
          <Show when={!followsTempo()}>
            <label class="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
              <span class="text-xs text-neutral-300">Beat</span>
              <div class="relative min-w-0" data-input-group="beat">
                <Input
                  density="compact"
                  aria-label="Step FX beat"
                  aria-invalid={Boolean(props.beatError)}
                  type="number"
                  min="0.001"
                  step="any"
                  class={`${STEP_FX_FIELD_CLASS} w-full min-w-0 pe-28 ${props.beatError ? "border-red-500" : ""}`}
                  value={stepFxBeatValue(props.stepFx.timing, props.beatUnit)}
                  onChange={(event) => {
                    const timing = stepFxTimingFromBeat(
                      Number(event.currentTarget.value),
                      props.beatUnit,
                    );
                    if (timing) props.onTimingChange(timing);
                  }}
                />
                <div class="absolute inset-y-px right-px flex items-center">
                  <NativeSelect
                    density="compact"
                    aria-label="Step FX beat unit"
                    class="h-full w-28 rounded-r border-0 border-l border-neutral-700 bg-neutral-800 px-2 pe-7 text-xs text-neutral-200 focus:border-[var(--accent)] focus:outline-none"
                    value={props.beatUnit}
                    onChange={(event) =>
                      props.onBeatUnitChange(
                        event.currentTarget.value as StepFxBeatUnit,
                      )
                    }
                  >
                    <option>BPM</option>
                    <option>Hz</option>
                    <option>Seconds</option>
                    <option>Milliseconds</option>
                  </NativeSelect>
                </div>
              </div>
            </label>
          </Show>
          <TimebaseControl
            value={props.stepFx.timebase ?? Timebase.Seconds}
            onChange={props.onTimebaseChange}
          />
          <div class="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
            <span class="pt-2 text-xs text-neutral-300">Scale cycle</span>
            <div class="min-w-0 space-y-1">
              <div
                class="flex min-w-0 items-center gap-1.5"
                data-input-group="cycle-scale"
              >
                <SegmentedControl
                  label="Step FX cycle scaling"
                  density="compact"
                  options={CYCLE_SCALE_OPTIONS}
                  value={props.stepFx.cycle_scale.type}
                  onChange={(type) =>
                    props.onCycleScaleChange(
                      type === "Auto"
                        ? { type: "Auto" }
                        : { type: "Fixed", data: fixedScaleValue() },
                    )
                  }
                />
                <div class="relative min-w-0 flex-1">
                  <Input
                    density="compact"
                    aria-label="Step FX cycle beats"
                    aria-invalid={Boolean(props.scaleError)}
                    type="number"
                    min="0.001"
                    step="any"
                    disabled={props.stepFx.cycle_scale.type !== "Fixed"}
                    class={`${STEP_FX_FIELD_CLASS} w-full min-w-0 pe-10 text-right disabled:text-neutral-600 ${props.scaleError ? "border-red-500" : ""}`}
                    value={
                      props.stepFx.cycle_scale.type === "Fixed"
                        ? props.stepFx.cycle_scale.data
                        : props.fixedScaleDefault
                    }
                    onInput={(event) => {
                      const value = Number(event.currentTarget.value);
                      setFixedScaleValue(value);
                      props.onCycleScaleChange({
                        type: "Fixed",
                        data: value,
                      });
                    }}
                  />
                  <span class="pointer-events-none absolute inset-y-0 right-1.5 flex items-center text-[10px] text-neutral-400">
                    beats
                  </span>
                </div>
              </div>
              <div class="text-[11px] text-neutral-500">
                {props.stepFx.cycle_scale.type === "Auto"
                  ? `${props.trackKind === "absolute" ? "Absolute" : "Relative"} steps cycle: ${props.cycleBeatText ?? "—"} beats`
                  : `Steps are scaled proportionally to fit a ${props.cycleBeatText ?? "—"}-beat cycle`}
              </div>
            </div>
          </div>
        </div>
      </div>
    </DropdownMenu>
  );
}
