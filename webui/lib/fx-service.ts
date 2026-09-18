// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FlowWaveform } from "../types";
import * as types from "../types";
import { WaveformKind } from "../types";
import { requireCommandSuccess } from "./command-result";
import { durationToSeconds, secondsToDuration } from "./duration";
import { engineRuntime } from "./engine-runtime";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

// FxPreviewUpdate type - matches backend FxPreviewUpdate enum
// Generated types will be available after running scripts/export-tsd.sh
type FxPreviewUpdate =
  | { type: "StartPreview"; data: types.Fx }
  | { type: "UpdatePreview"; data: types.Fx }
  | { type: "StopPreview" };

/**
 * Converts UI seconds into the backend duration shape used by FX commands.
 */
function toDuration(seconds: number): types.Duration {
  return secondsToDuration(seconds);
}

/**
 * Converts a backend FX duration into seconds for UI editors and waveform controls.
 */
function fromDuration(duration: types.Duration): number {
  return durationToSeconds(duration);
}

/**
 * Stores an FX definition through the backend FX command channel.
 */
export function storeFx(fx: types.Fx): void {
  const command: types.FxCommand = {
    type: "StoreFx",
    data: fx,
  };
  engineRuntime.sendCommand({ module: "FxCommand", command });
  log.info(`Stored fx ${fx.identifiers.id}:`, fx);
}

/** Stores or updates a module-backed FX definition. */
export function storeFxModule(request: types.StoredFxModuleRequest): void {
  const command: types.FxModuleCommand = {
    type: "StoreFxModule",
    data: request,
  };
  engineRuntime.sendCommand({ module: "FxModuleCommand", command });
  log.info(`Stored module fx ${request.identifiers.id}:`, request);
}

/** Requests a fresh catalog of available WebAssembly FX modules. */
export async function refreshAvailableFxModules(): Promise<types.CommandResult> {
  const command: types.FxModuleCommand = {
    type: "ListAvailableFxModules",
  };
  const result = await engineRuntime.sendCommandAndAwait({
    module: "FxModuleCommand",
    command,
  });

  requireCommandSuccess(result);

  return result;
}
export function deleteFx(id: number): void {
  const command: types.FxCommand = {
    type: "DeleteFx",
    data: id,
  };
  engineRuntime.sendCommand({ module: "FxCommand", command });
  log.info(`Deleted fx ${id}`);
}

/** Deletes a module-backed FX definition through its domain-specific command channel. */
export function deleteFxModule(id: number): void {
  const command: types.FxModuleCommand = {
    type: "DeleteFxModule",
    data: id,
  };
  engineRuntime.sendCommand({ module: "FxModuleCommand", command });
  log.info(`Deleted module fx ${id}`);
}

/**
 * Create a new default waveform FX with the given ID.
 * Sets up a basic sine wave on Intensity.
 */
export function createDefaultFx(id: number, label?: string): types.Fx {
  return {
    identifiers: {
      id,
      uid: crypto.randomUUID(),
      label: label ?? `FX ${id}`,
    },
    selection: {
      source: { type: "Fixture", data: { fixture_id: 1 } },
      clauses: [],
    },
    attributes: {
      Intensity: {
        rate: { secs: 1, nanos: 0 },
        width: 1.0,
        phase_range: [0, 2 * Math.PI],
        is_relative: false,
        params: {
          kind: WaveformKind.Sin,
          min: 0,
          max: 255,
          duty_cycle: 1.0,
        },
      },
    },
  };
}

/** Creates the valid default two-step intensity chase used by new editors. */
export function createDefaultStepFx(id: number, label?: string): types.StepFx {
  return {
    identifiers: {
      id,
      uid: crypto.randomUUID(),
      label: label ?? `Step FX ${id}`,
    },
    selection: {
      source: { type: "Fixture", data: { fixture_id: 1 } },
      clauses: [],
    },
    timing: { beat_duration: { secs: 0, nanos: 500_000_000 } },
    phase: { waypoints: [0, 1] },
    direction: types.FxDirection.Forward,
    cycle_scale: { type: "Auto" },
    lanes: [
      {
        attribute: { type: "Intensity" },
        absolute: {
          steps: [
            {
              uid: crypto.randomUUID(),
              target: { type: "AbsolutePercent", data: { value: 1 } },
              width_beats: 1,
              transition: { start: 0, end: 1 },
              curve: { type: "Snap", data: {} },
            },
            {
              uid: crypto.randomUUID(),
              target: { type: "AbsolutePercent", data: { value: 0 } },
              width_beats: 1,
              transition: { start: 0, end: 1 },
              curve: { type: "Snap", data: {} },
            },
          ],
        },
      },
    ],
  };
}

/** Stores a step FX definition through the existing step FX command channel. */
export function storeStepFx(stepFx: types.StepFx): void {
  const command: types.StepFxCommand = {
    type: "Store",
    data: stepFx,
  };
  engineRuntime.sendCommand({ module: "StepFxCommand", command });
  log.info(`Stored step fx ${stepFx.identifiers.id}:`, stepFx);
}

/** Stores a Step FX and resolves after its terminal command result. */
export async function storeStepFxAndWait(
  stepFx: types.StepFx,
): Promise<types.CommandResult> {
  const command: types.StepFxCommand = { type: "Store", data: stepFx };
  const result = await engineRuntime.sendCommandAndAwait({
    module: "StepFxCommand",
    command,
  });
  requireCommandSuccess(result);
  log.info(`Stored step fx ${stepFx.identifiers.id}:`, stepFx);
  return result;
}

/** Deletes a stored Step FX through its undoable command lifecycle. */
export function deleteStepFx(id: number): void {
  const command: types.StepFxCommand = { type: "Delete", data: id };
  engineRuntime.sendCommand({ module: "StepFxCommand", command });
  log.info(`Deleted step fx ${id}`);
}

/** Starts an editor-owned Step FX preview session. */
export function startStepFxPreview(
  sessionId: string,
  stepFx: types.StepFx,
): boolean {
  const update: types.StepFxPreviewUpdate = {
    type: "Start",
    data: { session_id: sessionId, step_fx: stepFx },
  };
  return engineRuntime.sendUpdate("StepFxPreviewUpdate", update);
}

/** Updates an editor-owned Step FX preview session. */
export function updateStepFxPreview(
  sessionId: string,
  stepFx: types.StepFx,
): boolean {
  const update: types.StepFxPreviewUpdate = {
    type: "Update",
    data: { session_id: sessionId, step_fx: stepFx },
  };
  return engineRuntime.sendUpdate("StepFxPreviewUpdate", update);
}

/** Stops only the addressed editor-owned Step FX preview session. */
export function stopStepFxPreview(sessionId: string): boolean {
  const update: types.StepFxPreviewUpdate = {
    type: "Stop",
    data: { session_id: sessionId },
  };
  return engineRuntime.sendUpdate("StepFxPreviewUpdate", update);
}

// FX Preview commands

/**
 * Start FX preview.
 */
export function startFxPreview(fx: types.Fx): void {
  const update: FxPreviewUpdate = {
    type: "StartPreview",
    data: fx,
  };
  engineRuntime.sendUpdate("FxPreviewUpdate", update);
  log.info(`Started fx preview for ${fx.identifiers.label}`);
}

export function updateFxPreview(fx: types.Fx): void {
  const update: FxPreviewUpdate = {
    type: "UpdatePreview",
    data: fx,
  };
  engineRuntime.sendUpdate("FxPreviewUpdate", update);
}

export function stopFxPreview(): void {
  const update: FxPreviewUpdate = {
    type: "StopPreview",
  };
  engineRuntime.sendUpdate("FxPreviewUpdate", update);
  log.info("Stopped fx preview");
}

/**
 * Clamps numeric waveform fields before mapping them to backend FX ranges.
 */
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const waveformMinMax = (waveform: FlowWaveform) => {
  const min = clamp(waveform.base, 0, 1) * 255;
  const max = clamp(waveform.base + waveform.amplitude, 0, 1) * 255;
  return {
    min: Math.round(min),
    max: Math.round(max),
  };
};

/**
 * Convert FlowWaveform to FxWaveform for backend API calls.
 * @param waveform - The FlowWaveform to convert
 * @param isRelative - The is_relative flag (FX-specific)
 */
export function flowWaveformToFxWaveform(
  waveform: FlowWaveform,
  isRelative = false,
): types.FxWaveform {
  const { min, max } = waveformMinMax(waveform);
  const dutyCycle = waveform.duty_cycle ?? 1.0;
  const phaseStart = waveform.phase;
  const phaseEnd = phaseStart + 2 * Math.PI;
  // Construct the object in the format the Rust backend expects
  // The Rust FxWaveform has params: FxWaveformParams, not waveform: WaveType
  return {
    params: {
      kind: waveform.kind, // WaveformKind values are already the correct format
      min,
      max,
      duty_cycle: dutyCycle,
    },
    phase_range: [phaseStart, phaseEnd],
    rate: toDuration(waveform.rate_secs),
    width: 1.0,
    is_relative: isRelative,
  };
}

/**
 * Convert FxWaveform to FlowWaveform when loading from backend.
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

  const min = clamp((params.min ?? 0) / 255, 0, 1);
  const max = clamp((params.max ?? 255) / 255, 0, 1);
  // params.kind is already a WaveformKind value (lowercase string)
  const kind = (params.kind as WaveformKind) ?? WaveformKind.Sin;
  const dutyCycle = params.duty_cycle ?? 1.0;

  return {
    kind,
    rate_secs: fromDuration(waveform.rate),
    amplitude: clamp(max - min, 0, 1),
    phase: waveform.phase_range?.[0] ?? 0,
    base: min,
    duty_cycle: dutyCycle,
  };
}

/**
 * Create a default FlowWaveform.
 */
export function createDefaultFlowWaveform(): FlowWaveform {
  return {
    kind: WaveformKind.Sin,
    rate_secs: 1,
    amplitude: 1,
    phase: 0,
    base: 0,
    duty_cycle: 1.0,
  };
}
