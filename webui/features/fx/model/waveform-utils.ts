// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FlowWaveform, WaveformKind } from "../../../types";

/** Function that computes waveform value (0-1) at a given phase (0-1) */
type WaveformFn = (phase: number, dutyCycle?: number) => number;

/** Waveform generation functions for each wave type */
const waveforms: Record<string, WaveformFn> = {
  SinWave: (phase, dutyCycle = 1.0) => {
    if (phase >= dutyCycle) return 0.5;
    const rescaled = phase / dutyCycle;
    // Base waveform output: sin goes 0 -> 1 -> 0 -> -1 -> 0 over one cycle
    // Normalize to 0-1 range: (sin + 1) / 2 gives us 0.5 -> 1 -> 0.5 -> 0 -> 0.5
    return (Math.sin(rescaled * 2 * Math.PI) + 1) / 2;
  },
  Sine: (phase, dutyCycle = 1.0) => {
    if (phase >= dutyCycle) return 0.5;
    const rescaled = phase / dutyCycle;
    return (Math.sin(rescaled * 2 * Math.PI) + 1) / 2;
  },
  Triangle: (phase, dutyCycle = 1.0) => {
    if (phase >= dutyCycle) return 0.5;
    const rescaled = phase / dutyCycle;
    // Triangle: 0.5 -> 1 -> 0.5 -> 0 -> 0.5
    if (rescaled < 0.25) return 0.5 + rescaled * 2;
    if (rescaled < 0.75) return 1 - (rescaled - 0.25) * 2;
    return (rescaled - 0.75) * 2;
  },
  Sawtooth: (phase, dutyCycle = 1.0) => {
    if (phase >= dutyCycle) return 0.5;
    const rescaled = phase / dutyCycle;
    // Sawtooth: rises from 0.5 (base) to 1 (max), then drops back to 0.5 (base)
    // Linear rise from base to peak, then instant drop back to base
    return 0.5 + rescaled * 0.5;
  },
  Square: (phase, dutyCycle = 0.5) => (phase < dutyCycle ? 1 : 0),
  Pulse: (phase, dutyCycle = 0.25) => (phase < dutyCycle ? 1 : 0),
};

/** Default waveform function (sine wave) */
const defaultWaveformFn: WaveformFn = waveforms.SinWave;

/** Map WaveformKind to waveform function */
const kindToWaveformFn: Record<WaveformKind, WaveformFn> = {
  sin: waveforms.SinWave,
  triangle: waveforms.Triangle,
  sawtooth: waveforms.Sawtooth,
  square: waveforms.Square,
  pulse: waveforms.Pulse,
};

/**
 * Generate an SVG path string from a FlowWaveform.
 * Uses normalized 0-1 values directly without DMX conversion.
 * @param waveform - The FlowWaveform configuration
 * @param samples - Number of samples to generate
 * @returns SVG path d attribute string
 */
export function generateSvgPathFromFlow(
  waveform: FlowWaveform,
  samples = 200,
): string {
  const fn = kindToWaveformFn[waveform.kind] ?? defaultWaveformFn;
  // Convert radians to normalized phase (0-1)
  const phaseOffset = waveform.phase / (2 * Math.PI);
  const dutyCycle = waveform.duty_cycle ?? 1.0;
  const points: string[] = [];

  // base is the minimum (normalized 0-1)
  // amplitude is the range above base (normalized 0-1)
  const base = Math.max(0, Math.min(1, waveform.base));
  const amplitude = Math.max(0, Math.min(1, waveform.amplitude));

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    // Apply phase offset and wrap to 0-1
    const normalizedPhase = (((t + phaseOffset) % 1) + 1) % 1;
    // Get base waveform value (0-1)
    const rawValue = fn(normalizedPhase, dutyCycle);
    // Scale by amplitude and add base
    // rawValue is 0-1, we want output to be base to (base + amplitude)
    const scaledValue = base + rawValue * amplitude;
    // Clamp to 0-1 range
    const clampedValue = Math.max(0, Math.min(1, scaledValue));
    // Convert to SVG coordinates (0-100 range, inverted Y)
    const x = t * 100;
    const y = (1 - clampedValue) * 100;
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
  }

  return points.join(" ");
}
