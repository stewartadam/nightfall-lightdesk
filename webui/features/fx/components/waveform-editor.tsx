// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, Show } from "solid-js";
import {
  Input,
  InputGroup,
  InputSuffix,
} from "../../../components/ui/form-controls";
import { RangeSlider } from "../../../components/ui/range-slider";
import { ToggleSwitch } from "../../../components/ui/toggle-switch";
import { type FlowWaveform, WaveformKind } from "../../../types";
import { WaveformCanvas } from "./waveform-canvas";
import { WaveformPresets } from "./waveform-presets";

export interface WaveformEditorProps {
  title?: string;
  /** The waveform configuration (FlowWaveform with normalized 0-1 values) */
  waveform: FlowWaveform;
  /** Callback when waveform fields are updated */
  onWaveformChange: (updates: Partial<FlowWaveform>) => void;
  /** Whether to show the Relative checkbox (FX editor only) */
  showRelative?: boolean;
  /** Current is_relative value (FX editor only) */
  isRelative?: boolean;
  /** Callback when is_relative changes (FX editor only) */
  onRelativeChange?: (relative: boolean) => void;
  /** Fields that are disabled because they have upstream connections */
  disabledFields?: {
    kind?: boolean;
    rate?: boolean;
    amplitude?: boolean;
    phase?: boolean;
    base?: boolean;
    dutyCycle?: boolean;
  };
}

/**
 * Pure waveform editor UI used by FX and Flow properties.
 * Works with FlowWaveform (normalized 0-1 values).
 */
export function WaveformEditor(props: WaveformEditorProps) {
  const phaseDegrees = createMemo(() =>
    Math.round((props.waveform.phase / (2 * Math.PI)) * 360),
  );

  const showRelative = () => props.showRelative ?? false;

  const isDisabled = (field: keyof NonNullable<typeof props.disabledFields>) =>
    props.disabledFields?.[field] ?? false;

  /** Applies the selected shape and resets an editable square duty cycle. */
  const selectKind = (kind: WaveformKind) => {
    if (isDisabled("kind")) return;
    props.onWaveformChange(
      kind === WaveformKind.Square && !isDisabled("dutyCycle")
        ? { kind, duty_cycle: 0.5 }
        : { kind },
    );
  };

  return (
    <div class="waveform-editor flex flex-col gap-3 p-3 bg-neutral-800/50 rounded-lg">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <Show when={props.title} fallback={<span />}>
          <span class="text-sm font-medium text-neutral-300">
            {props.title}
          </span>
        </Show>
        <div class={isDisabled("kind") ? "opacity-50 pointer-events-none" : ""}>
          <WaveformPresets
            attribute={props.title ?? "Waveform"}
            currentKind={props.waveform.kind}
            onSelect={selectKind}
          />
        </div>
      </div>

      <WaveformCanvas
        waveform={props.waveform}
        onPhaseChange={
          isDisabled("phase")
            ? () => {}
            : (phase) => props.onWaveformChange({ phase })
        }
        onAmplitudeChange={
          isDisabled("amplitude")
            ? undefined
            : (amplitude) => props.onWaveformChange({ amplitude })
        }
      />

      <div class="flex flex-col gap-4 border-t border-neutral-700 pt-3">
        <div class="grid grid-cols-1 gap-x-6 gap-y-14 pb-8 text-xs md:grid-cols-2">
          <div
            class={`flex flex-col gap-1 ${isDisabled("amplitude") ? "opacity-50" : ""}`}
          >
            <span
              class={
                isDisabled("amplitude")
                  ? "text-neutral-500"
                  : "text-neutral-400"
              }
            >
              Amplitude
              {isDisabled("amplitude") && (
                <span class="ml-1 text-[10px]">(wired)</span>
              )}
            </span>
            <RangeSlider
              value={props.waveform.amplitude * 100}
              disabled={isDisabled("amplitude")}
              onChange={(value: number) => {
                if (!isDisabled("amplitude")) {
                  props.onWaveformChange({ amplitude: value / 100 });
                }
              }}
            />
          </div>

          <div
            class={`flex flex-col gap-1 ${isDisabled("base") ? "opacity-50" : ""}`}
          >
            <span
              class={
                isDisabled("base") ? "text-neutral-500" : "text-neutral-400"
              }
            >
              Base
              {isDisabled("base") && (
                <span class="ml-1 text-[10px]">(wired)</span>
              )}
            </span>
            <RangeSlider
              value={props.waveform.base * 100}
              disabled={isDisabled("base")}
              onChange={(value: number) => {
                if (!isDisabled("base")) {
                  props.onWaveformChange({ base: value / 100 });
                }
              }}
            />
          </div>

          <div
            class={`flex flex-col gap-1 ${isDisabled("dutyCycle") ? "opacity-50" : ""}`}
          >
            <span
              class={
                isDisabled("dutyCycle")
                  ? "text-neutral-500"
                  : "text-neutral-400"
              }
            >
              Duty Cycle
              {isDisabled("dutyCycle") && (
                <span class="ml-1 text-[10px]">(wired)</span>
              )}
            </span>
            <RangeSlider
              value={(props.waveform.duty_cycle ?? 1.0) * 100}
              disabled={isDisabled("dutyCycle")}
              onChange={(value: number) => {
                if (!isDisabled("dutyCycle")) {
                  props.onWaveformChange({ duty_cycle: value / 100 });
                }
              }}
            />
          </div>

          <div
            class={`flex flex-col gap-1 ${isDisabled("phase") ? "opacity-50" : ""}`}
          >
            <span
              class={
                isDisabled("phase") ? "text-neutral-500" : "text-neutral-400"
              }
            >
              Phase
              {isDisabled("phase") && (
                <span class="ml-1 text-[10px]">(wired)</span>
              )}
            </span>
            <RangeSlider
              value={phaseDegrees()}
              min={0}
              max={360}
              step={1}
              suffix="deg"
              disabled={isDisabled("phase")}
              onChange={(degrees: number) => {
                if (!isDisabled("phase")) {
                  const radians = (degrees / 360) * 2 * Math.PI;
                  props.onWaveformChange({ phase: radians });
                }
              }}
            />
          </div>
        </div>

        <div class="flex flex-col gap-2 text-xs md:max-w-sm">
          <label class="flex items-center justify-between">
            <span
              class={
                isDisabled("rate") ? "text-neutral-500" : "text-neutral-400"
              }
            >
              Rate
              {isDisabled("rate") && (
                <span class="ml-1 text-[10px]">(wired)</span>
              )}
            </span>
            <InputGroup>
              <Input
                density="compact"
                type="number"
                step="0.1"
                min="0.1"
                value={props.waveform.rate_secs.toFixed(2)}
                disabled={isDisabled("rate")}
                onInput={(e) => {
                  if (isDisabled("rate")) return;
                  const value = Number.parseFloat(e.currentTarget.value);
                  if (!Number.isNaN(value) && value > 0) {
                    props.onWaveformChange({ rate_secs: value });
                  }
                }}
                class="w-14 text-right"
              />
              <InputSuffix>s</InputSuffix>
            </InputGroup>
          </label>

          <Show when={showRelative()}>
            <ToggleSwitch
              label="Relative"
              ariaLabel="Relative"
              class="justify-between"
              checked={props.isRelative ?? false}
              onChange={(value) => props.onRelativeChange?.(value)}
            />
          </Show>
        </div>
      </div>
    </div>
  );
}
