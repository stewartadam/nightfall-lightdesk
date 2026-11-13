// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { type FlowWaveform, WaveformKind } from "../types";
import { durationToSeconds, secondsToDuration } from "./duration";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

/**
 * Clamps numeric waveform fields before mapping them to backend FX ranges.
 */
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * Returns a waveform's lowest and highest output as fractions (0-1) of the driven
 * parameter's range, which is how the backend stores FX waveform bounds.
 */
const waveformMinMax = (waveform: FlowWaveform) => ({
  min: clamp(waveform.base, 0, 1),
  max: clamp(waveform.base + waveform.amplitude, 0, 1),
});

/**
 * Converts the editor's waveform into the backend FX waveform, storing its bounds as
 * fractions of the driven parameter's range.
 * @param waveform - The FlowWaveform to convert
 * @param isRelative - Whether the FX moves the parameter around its current value
 */
export function flowWaveformToFxWaveform(
  waveform: FlowWaveform,
  isRelative = false,
): types.FxWaveform {
  const { min, max } = waveformMinMax(waveform);
  const dutyCycle = waveform.duty_cycle ?? 1.0;
  const phaseStart = waveform.phase;
  const phaseEnd = phaseStart + 2 * Math.PI;
  return {
    params: {
      kind: waveform.kind,
      min,
      max,
      duty_cycle: dutyCycle,
    },
    phase_range: [phaseStart, phaseEnd],
    cycle_length: secondsToDuration(waveform.cycle_length_secs),
    width: 1.0,
    is_relative: isRelative,
  };
}

/**
 * Converts a backend FX waveform into the editor's waveform, falling back to the
 * default waveform when the stored params are missing.
 * @param waveform - The FxWaveform to convert
 */
export function fxWaveformToFlowWaveform(
  waveform: types.FxWaveform,
): FlowWaveform {
  const params = (
    waveform as unknown as {
      params?: {
        kind?: string;
        min?: number;
        max?: number;
        duty_cycle?: number;
      };
    }
  )?.params;
  if (!params) {
    log.warn(
      "fxWaveformToFlowWaveform: waveform params are missing or malformed",
      waveform,
    );
    return createDefaultFlowWaveform();
  }

  const min = clamp(params.min ?? 0, 0, 1);
  const max = clamp(params.max ?? 1, 0, 1);
  const kind = (params.kind as WaveformKind) ?? WaveformKind.Sin;
  const dutyCycle = params.duty_cycle ?? 1.0;

  return {
    kind,
    cycle_length_secs: durationToSeconds(waveform.cycle_length),
    amplitude: clamp(max - min, 0, 1),
    phase: waveform.phase_range?.[0] ?? 0,
    base: min,
    duty_cycle: dutyCycle,
  };
}

/**
 * Returns the waveform new FX attributes start with: a one-second sine over the
 * attribute's full range.
 */
export function createDefaultFlowWaveform(): FlowWaveform {
  return {
    kind: WaveformKind.Sin,
    cycle_length_secs: 1,
    amplitude: 1,
    phase: 0,
    base: 0,
    duty_cycle: 1.0,
  };
}
