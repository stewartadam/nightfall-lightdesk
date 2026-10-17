// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Collapsible } from "../../../../components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuSeparator,
} from "../../../../components/ui/dropdown-menu";
import { Input } from "../../../../components/ui/form-controls";
import { RangeSlider } from "../../../../components/ui/range-slider";
import { Button } from "../../../../components/ui/visual-language/button";
import type * as types from "../../../../types";
import {
  type StepFxPositionUnit,
  type StepFxStartPositionMode,
  stepFxPositionUnitScale,
  stepFxPositionUnitSuffix,
  stepFxStartPositionMode,
  stepFxStartPositionSummary,
} from "../../model/step-fx-editor-model";
import { StepFxPhaseField } from "../step-fx-phase-field";
import { STEP_FX_FIELD_CLASS } from "./step-fx-editor-styles";
import { StepFxPhaseDial } from "./step-fx-phase-dial";

/** Renders common phase patterns visually while preserving advanced waypoint syntax. */
export function StepFxStartPositionControls(props: {
  phase: types.StepFxPhase;
  open: boolean;
  highlighted: boolean;
  advancedFocusRequest: number;
  selectionCount: number;
  positionUnit: StepFxPositionUnit;
  onPositionUnitChange: (unit: StepFxPositionUnit) => void;
  onSpreadEditingChange: (editing: boolean) => void;
  onOpenChange: (isOpen: boolean) => void;
  onChange: (phase: types.StepFxPhase) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = createSignal(
    stepFxStartPositionMode(props.phase) === "custom",
  );
  /** Returns the first authored waypoint in the selected display unit. */
  const startValue = (): number =>
    (props.phase.waypoints[0] ?? 0) *
    stepFxPositionUnitScale(props.positionUnit);
  /** Returns the signed two-point spread in the selected display unit. */
  const spreadValue = (): number =>
    ((props.phase.waypoints[1] ?? props.phase.waypoints[0] ?? 0) -
      (props.phase.waypoints[0] ?? 0)) *
    stepFxPositionUnitScale(props.positionUnit);
  /** Returns the direction sign currently applied to spread magnitude controls. */
  const spreadSign = (): -1 | 1 => (spreadValue() < 0 ? -1 : 1);
  /** Reports whether the open menu is actively exposing common spread controls. */
  createEffect(() => {
    props.onSpreadEditingChange(
      props.open && stepFxStartPositionMode(props.phase) === "spread",
    );
  });
  /** Reveals the advanced field before forwarding a shortcut focus request. */
  createEffect(() => {
    if (props.advancedFocusRequest > 0) setAdvancedOpen(true);
  });
  onCleanup(() => props.onSpreadEditingChange(false));
  /** Publishes a mode change using predictable defaults around the current start. */
  const setMode = (mode: StepFxStartPositionMode): void => {
    const start = props.phase.waypoints[0] ?? 0;
    if (mode === "together") {
      props.onChange({ waypoints: [start] });
      return;
    }
    if (mode === "spread") {
      props.onChange({ waypoints: [start, start + 1] });
      return;
    }
    props.onChange({ waypoints: [start, start + 1, start] });
  };
  /** Moves the complete distribution without changing its authored shape. */
  const setStartValue = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const nextStart = value / stepFxPositionUnitScale(props.positionUnit);
    const currentStart = props.phase.waypoints[0] ?? 0;
    const delta = nextStart - currentStart;
    props.onChange({
      waypoints:
        props.phase.waypoints.length > 0
          ? props.phase.waypoints.map((waypoint) => waypoint + delta)
          : [nextStart],
    });
  };
  /** Updates the common two-point spread while retaining its start angle. */
  const setSpreadValue = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const start = props.phase.waypoints[0] ?? 0;
    props.onChange({
      waypoints: [
        start,
        start + value / stepFxPositionUnitScale(props.positionUnit),
      ],
    });
  };
  /** Reverses only the authored spread direction while preserving its magnitude. */
  const reverseSpread = (): void => {
    const current = spreadValue();
    const fallback = stepFxPositionUnitScale(props.positionUnit);
    setSpreadValue(current === 0 ? -fallback : -current);
  };
  /** Applies a preset magnitude without changing the current spread direction. */
  const setSpreadMagnitude = (value: number): void => {
    setSpreadValue(spreadSign() * value);
  };

  return (
    <DropdownMenu
      placement="below"
      align="start"
      triggerLabel="Start position"
      open={props.open}
      onOpenChange={props.onOpenChange}
      triggerSize="compact"
      triggerClass={
        props.highlighted ? "ring-1 ring-inset ring-amber-300/70" : undefined
      }
      trigger={
        <span
          class="inline-flex items-center gap-1.5 tabular-nums"
          classList={{ "text-amber-100": props.highlighted }}
          data-waveform-drag-active={props.highlighted ? "true" : undefined}
        >
          {stepFxStartPositionSummary(props.phase, props.positionUnit)}
          <CaretDownIcon class="size-3" aria-hidden />
        </span>
      }
    >
      <div class="w-[22rem] py-1" data-menu-kind="step-fx-start-position">
        <div class="flex items-start justify-between gap-3 px-3 py-2">
          <div>
            <div class="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Start position
            </div>
            <div class="text-xs text-neutral-500">
              Place the selection together or distribute it around the cycle.
            </div>
          </div>
          <div
            class="inline-flex shrink-0 rounded border border-neutral-700 bg-neutral-900 p-0.5"
            role="radiogroup"
            aria-label="Start position units"
          >
            <For each={["percent", "degrees"] as const}>
              {(unit) => (
                <button
                  type="button"
                  role="radio"
                  aria-label={unit === "percent" ? "Percent" : "Degrees"}
                  aria-checked={props.positionUnit === unit}
                  class={`rounded px-2 py-1 text-xs transition-colors hover:bg-neutral-700 ${props.positionUnit === unit ? "bg-blue-600 text-white" : "text-neutral-300"}`}
                  onClick={() => props.onPositionUnitChange(unit)}
                >
                  {stepFxPositionUnitSuffix(unit)}
                </button>
              )}
            </For>
          </div>
        </div>
        <DropdownMenuSeparator />
        <div class="space-y-3 px-3 py-2">
          <div
            class="grid grid-cols-3 rounded border border-neutral-700 bg-neutral-900 p-0.5"
            role="radiogroup"
            aria-label="Start position mode"
          >
            <For each={["together", "spread", "custom"] as const}>
              {(mode) => (
                <button
                  type="button"
                  role="radio"
                  aria-label={`${mode[0]?.toUpperCase()}${mode.slice(1)} start position`}
                  aria-checked={stepFxStartPositionMode(props.phase) === mode}
                  class={`rounded px-2 py-1.5 text-xs capitalize transition-colors hover:bg-neutral-700 ${stepFxStartPositionMode(props.phase) === mode ? "bg-blue-600 text-white" : "text-neutral-300"}`}
                  onClick={() => setMode(mode)}
                >
                  {mode}
                </button>
              )}
            </For>
          </div>

          <div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
            <StepFxPhaseDial
              phase={props.phase}
              selectionCount={props.selectionCount}
            />
            <div class="space-y-2">
              <label class="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2 text-xs text-neutral-300">
                Start
                <div class="relative">
                  <Input
                    density="compact"
                    type="number"
                    step="1"
                    aria-label="Start position value"
                    class={`${STEP_FX_FIELD_CLASS} w-full pe-7 text-right`}
                    value={Number(startValue().toFixed(1))}
                    onInput={(event) =>
                      setStartValue(Number(event.currentTarget.value))
                    }
                  />
                  <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-neutral-500">
                    {stepFxPositionUnitSuffix(props.positionUnit)}
                  </span>
                </div>
              </label>
              <RangeSlider
                value={
                  ((startValue() %
                    stepFxPositionUnitScale(props.positionUnit)) +
                    stepFxPositionUnitScale(props.positionUnit)) %
                  stepFxPositionUnitScale(props.positionUnit)
                }
                max={stepFxPositionUnitScale(props.positionUnit)}
                suffix={stepFxPositionUnitSuffix(props.positionUnit)}
                ariaLabel="Start position dial"
                showPips={false}
                showInputs={false}
                containerClass="w-full"
                onChange={setStartValue}
              />
              <div class="grid grid-cols-4 gap-1">
                <For
                  each={
                    props.positionUnit === "percent"
                      ? [0, 25, 50, 75]
                      : [0, 90, 180, 270]
                  }
                >
                  {(value) => (
                    <Button size="compact" onClick={() => setStartValue(value)}>
                      {value}
                      {stepFxPositionUnitSuffix(props.positionUnit)}
                    </Button>
                  )}
                </For>
              </div>
              <Show when={stepFxStartPositionMode(props.phase) === "spread"}>
                <label class="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2 pt-1 text-xs text-neutral-300">
                  Spread
                  <div class="relative">
                    <Input
                      density="compact"
                      type="number"
                      step="1"
                      aria-label="Spread amount"
                      class={`${STEP_FX_FIELD_CLASS} w-full pe-7 text-right`}
                      value={Number(spreadValue().toFixed(1))}
                      onInput={(event) =>
                        setSpreadValue(Number(event.currentTarget.value))
                      }
                    />
                    <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-neutral-500">
                      {stepFxPositionUnitSuffix(props.positionUnit)}
                    </span>
                  </div>
                </label>
                <RangeSlider
                  value={Math.min(
                    Math.abs(spreadValue()),
                    stepFxPositionUnitScale(props.positionUnit),
                  )}
                  max={stepFxPositionUnitScale(props.positionUnit)}
                  suffix={stepFxPositionUnitSuffix(props.positionUnit)}
                  ariaLabel="Spread amount slider"
                  showPips={false}
                  showInputs={false}
                  containerClass="w-full"
                  onChange={setSpreadMagnitude}
                />
                <div class="grid grid-cols-4 gap-1">
                  <For
                    each={
                      props.positionUnit === "percent"
                        ? [25, 50, 100]
                        : [90, 180, 360]
                    }
                  >
                    {(value) => (
                      <Button
                        size="compact"
                        onClick={() => setSpreadMagnitude(value)}
                      >
                        {spreadSign() * value}
                        {stepFxPositionUnitSuffix(props.positionUnit)}
                      </Button>
                    )}
                  </For>
                  <Button size="compact" onClick={reverseSpread}>
                    Reverse
                  </Button>
                </div>
              </Show>
            </div>
          </div>

          <Show when={stepFxStartPositionMode(props.phase) === "custom"}>
            <div class="rounded border border-[var(--accent)] bg-[var(--accent-soft)] px-2 py-1.5 text-xs text-[var(--accent)]">
              Custom mode keeps each position in the sequence. Changing Start
              moves every position by the same amount.
            </div>
          </Show>

          <Collapsible
            variant="plain"
            triggerClass="text-xs"
            title="Advanced expression"
            open={
              advancedOpen() ||
              stepFxStartPositionMode(props.phase) === "custom"
            }
            onOpenChange={setAdvancedOpen}
          >
            <StepFxPhaseField
              ariaLabel="Advanced start position expression"
              phase={props.phase}
              focusRequest={props.advancedFocusRequest}
              onChange={props.onChange}
            />
            <div class="mt-1 text-[11px] text-neutral-500">
              Advanced expressions use degrees. Enter positions such as 180,
              0&gt;360, or 0&gt;360&gt;0.
            </div>
          </Collapsible>
        </div>
      </div>
    </DropdownMenu>
  );
}
