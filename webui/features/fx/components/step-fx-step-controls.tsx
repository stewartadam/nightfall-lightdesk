// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { createMemo, For } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "../../../components/ui/dropdown-menu";
import { Checkbox, Input } from "../../../components/ui/form-controls";
import type * as types from "../../../types";
import {
  stepFxSpeedValue,
  stepFxTimingFromSpeed,
} from "../model/step-fx-editor-model";
import { StepFxPhaseField } from "./step-fx-phase-field";

const FIELD_CLASS = "nf-form-control min-w-0";

const STEP_FX_CURVE_NAMES = [
  "Snap",
  "Linear",
  "Ease",
  "Ease In",
  "Ease Out",
] as const;

type StepFxCurveName = (typeof STEP_FX_CURVE_NAMES)[number];

/** Lane fields that can replace the effect-wide timing and phase for one lane. */
export type StepFxLaneOverrides = Pick<
  types.FxLane,
  "timing_override" | "phase_override"
>;

/** Renders an icon-capable selector for one authored transition curve. */
export function StepFxCurveSelect(props: {
  stepNumber: number;
  curve: types.CurveType;
  onChange: (curve: types.CurveType) => void;
}) {
  /** Resolves the persisted curve to the selector's supported visual preset. */
  const selectedName = createMemo(() => curveName(props.curve));

  return (
    <DropdownMenu
      align="end"
      triggerLabel={`Step ${props.stepNumber} curve`}
      triggerClass="block w-full min-w-0"
      trigger={
        <span
          class={`${FIELD_CLASS} flex w-full min-w-0 items-center gap-1 px-1.5 text-left text-xs`}
        >
          <StepFxCurveIcon
            name={selectedName()}
            class="size-4 shrink-0 text-neutral-400"
          />
          <span class="min-w-0 flex-1 truncate">{selectedName()}</span>
          <CaretDownIcon class="size-3 shrink-0 text-neutral-400" aria-hidden />
        </span>
      }
    >
      <div class="py-0.5" data-menu-kind="step-fx-curve">
        <For each={STEP_FX_CURVE_NAMES}>
          {(name) => (
            <DropdownMenuItem
              onClick={() => props.onChange(curveFromName(name))}
            >
              <span
                class="flex min-w-0 flex-1 items-center gap-2"
                classList={{ "text-sky-300": selectedName() === name }}
                data-step-fx-curve-option={name}
              >
                <StepFxCurveIcon
                  name={name}
                  class="size-4 shrink-0 text-current"
                />
                <span>{name}</span>
              </span>
            </DropdownMenuItem>
          )}
        </For>
      </div>
    </DropdownMenu>
  );
}

/** Draws the normalized interpolation shape represented by one curve preset. */
function StepFxCurveIcon(props: { name: StepFxCurveName; class?: string }) {
  return (
    <svg
      class={props.class ?? "size-4"}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-step-fx-curve-icon={props.name}
    >
      <path
        d={stepFxCurveIconPath(props.name)}
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="2" cy="14" r="1" fill="currentColor" />
      <circle cx="14" cy="2" r="1" fill="currentColor" />
    </svg>
  );
}

/** Returns compact SVG geometry that previews a supported interpolation curve. */
function stepFxCurveIconPath(name: StepFxCurveName): string {
  if (name === "Snap") return "M2 14 H8 V2 H14";
  if (name === "Linear") return "M2 14 L14 2";
  if (name === "Ease In") return "M2 14 C10 14 13 10 14 2";
  if (name === "Ease Out") return "M2 14 C3 6 6 2 14 2";
  return "M2 14 C8 14 8 2 14 2";
}

/** Renders lane-specific overrides at the end of a lane's step toolbar. */
export function StepFxOverridesControl<L extends StepFxLaneOverrides>(props: {
  lane: L;
  overall: types.StepFx;
  open: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onLaneChange: (lane: L) => void;
}) {
  return (
    <div class="flex shrink-0 items-center gap-1">
      <DropdownMenu
        placement="below"
        align="end"
        triggerLabel="Overrides"
        open={props.open}
        onOpenChange={props.onOpenChange}
        trigger={
          <span class="inline-flex h-8 items-center gap-1 rounded border border-neutral-700 bg-neutral-800 px-2 text-xs text-neutral-200 hover:bg-neutral-700">
            Overrides
            <CaretDownIcon class="size-3" aria-hidden />
          </span>
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
function AdvancedLaneControls<L extends StepFxLaneOverrides>(props: {
  lane: L;
  overall: types.StepFx;
  onChange: (lane: L) => void;
}) {
  /** Publishes an independently cloned lane update. */
  const update = (edit: (lane: L) => void): void => {
    const lane = structuredClone(props.lane);
    edit(lane);
    props.onChange(lane);
  };
  return (
    <div class="space-y-1 text-xs">
      <div
        class="grid grid-cols-[minmax(0,1fr)_8.5rem] items-center gap-2 rounded px-1 py-1"
        data-step-fx-lane-override="speed"
        role="group"
        aria-label="Speed override"
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
          <span class="whitespace-nowrap">Override speed</span>
        </label>
        <Input
          density="compact"
          aria-label="Lane BPM"
          type="number"
          min="0.001"
          disabled={!props.lane.timing_override}
          class={`${FIELD_CLASS} w-full min-w-0`}
          value={stepFxSpeedValue(
            props.lane.timing_override ?? props.overall.timing,
            "BPM",
          )}
          onChange={(event) => {
            const next = stepFxTimingFromSpeed(
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

/** Returns the constrained editor label for a persisted transition curve. */
function curveName(curve: types.CurveType): StepFxCurveName {
  if (curve.type !== "Bezier") return curve.type;
  const { cp1, cp2 } = curve.data;
  if (cp1.x === 0.42 && cp2.x === 1) return "Ease In";
  if (cp1.x === 0 && cp2.x === 0.58) return "Ease Out";
  return "Ease";
}

/** Creates one supported backend transition curve from its sheet label. */
function curveFromName(name: StepFxCurveName): types.CurveType {
  if (name === "Snap") return { type: "Snap", data: {} };
  if (name === "Linear") return { type: "Linear", data: {} };
  if (name === "Ease In")
    return {
      type: "Bezier",
      data: { cp1: { x: 0.42, y: 0 }, cp2: { x: 1, y: 1 } },
    };
  if (name === "Ease Out")
    return {
      type: "Bezier",
      data: { cp1: { x: 0, y: 0 }, cp2: { x: 0.58, y: 1 } },
    };
  return {
    type: "Bezier",
    data: { cp1: { x: 0.42, y: 0 }, cp2: { x: 0.58, y: 1 } },
  };
}
