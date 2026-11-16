// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { v4 as uuidv4 } from "uuid";
import * as types from "../types";
import { WaveformKind } from "../types";
import { requireCommandSuccess } from "./command-result";
import { commandClient } from "./engine-commands";
import { engineRuntime } from "./engine-runtime";
import { getLogger } from "./logger";
import { createShowObjectUid } from "./sequence-factory";

const log = getLogger(import.meta.url);

// FxPreviewUpdate type - matches backend FxPreviewUpdate enum
// Generated types will be available after running scripts/export-tsd.sh
type FxPreviewUpdate =
  | { type: "StartPreview"; data: types.Fx }
  | { type: "UpdatePreview"; data: types.Fx }
  | { type: "StopPreview" };

/**
 * Stores an FX definition through the backend FX command channel.
 */
export function storeFx(fx: types.Fx): void {
  const command: types.FxCommand = {
    type: "StoreFx",
    data: fx,
  };
  commandClient.emit("FxCommand", command);
  log.info(`Stored fx ${fx.identifiers.id}:`, fx);
}

/** Stores or updates a module-backed FX definition. */
export function storeFxModule(request: types.StoredFxModuleRequest): void {
  const command: types.FxModuleCommand = {
    type: "StoreFxModule",
    data: request,
  };
  commandClient.emit("FxModuleCommand", command);
  log.info(`Stored module fx ${request.identifiers.id}:`, request);
}

/** Requests a fresh catalog of available WebAssembly FX modules. */
export async function refreshAvailableFxModules(): Promise<types.CommandResult> {
  const command: types.FxModuleCommand = {
    type: "ListAvailableFxModules",
  };
  const result = await commandClient.invoke("FxModuleCommand", command);

  requireCommandSuccess(result);

  return result;
}
export function deleteFx(id: number): void {
  const command: types.FxCommand = {
    type: "DeleteFx",
    data: id,
  };
  commandClient.emit("FxCommand", command);
  log.info(`Deleted fx ${id}`);
}

/** Deletes a module-backed FX definition through its domain-specific command channel. */
export function deleteFxModule(id: number): void {
  const command: types.FxModuleCommand = {
    type: "DeleteFxModule",
    data: id,
  };
  commandClient.emit("FxModuleCommand", command);
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
      uid: uuidv4(),
      label: label ?? `FX ${id}`,
    },
    selection: {
      source: { type: "Fixture", data: { fixture_id: 1 } },
      clauses: [],
    },
    attributes: {
      Intensity: {
        cycle_length: { secs: 1, nanos: 0 },
        width: 1.0,
        phase_range: [0, 2 * Math.PI],
        is_relative: false,
        params: {
          kind: WaveformKind.Sin,
          min: 0,
          max: 1,
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
      uid: uuidv4(),
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
              uid: createShowObjectUid(),
              target: { type: "AbsolutePercent", data: { value: 1 } },
              width_beats: 1,
              transition: { start: 0, end: 1 },
              curve: { type: "Snap", data: {} },
            },
            {
              uid: createShowObjectUid(),
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
  commandClient.emit("StepFxCommand", command);
  log.info(`Stored step fx ${stepFx.identifiers.id}:`, stepFx);
}

/** Stores a Step FX and resolves after its terminal command result. */
export async function storeStepFxAndWait(
  stepFx: types.StepFx,
): Promise<types.CommandResult> {
  const command: types.StepFxCommand = { type: "Store", data: stepFx };
  const result = await commandClient.invoke("StepFxCommand", command);
  requireCommandSuccess(result);
  log.info(`Stored step fx ${stepFx.identifiers.id}:`, stepFx);
  return result;
}

/** Deletes a stored Step FX through its undoable command lifecycle. */
export function deleteStepFx(id: number): void {
  const command: types.StepFxCommand = { type: "Delete", data: id };
  commandClient.emit("StepFxCommand", command);
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
