// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { commandEnvelope } from "./command-envelope";
import { commandOutputValue } from "./command-result";
import { engineRuntime } from "./engine-runtime";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

/** Extracts the instance ID returned by a preview command. */
function instanceIdFromResult(result: types.CommandResult): types.InstanceId {
  const output = commandOutputValue(result);
  if (
    typeof output !== "object" ||
    output === null ||
    !("instance_id" in output) ||
    typeof output.instance_id !== "string"
  ) {
    throw new Error("Expected preview command to return a instance ID");
  }
  return output.instance_id;
}

export function sendCueUpdate(updatedCue: types.Cue, batchId?: string) {
  // Send StoreCue command to backend
  // Note: Backend handles flattening of multi-fixture instructions
  const storeCueCommand: types.CueCommand = {
    type: "StoreCue",
    data: updatedCue,
  };

  engineRuntime.sendCommand(
    commandEnvelope("CueCommand", storeCueCommand, batchId),
  );

  log.info(`Updated cue ${updatedCue.identifiers.id}:`, updatedCue);
}

export function sendSequenceUpdate(
  updatedSequence: types.Sequence,
  batchId?: string,
) {
  const storeSequenceCommand: types.CueCommand = {
    type: "StoreSequence",
    data: updatedSequence,
  };

  engineRuntime.sendCommand(
    commandEnvelope("CueCommand", storeSequenceCommand, batchId),
  );

  log.info(
    `Updated sequence ${updatedSequence.identifiers.id}:`,
    updatedSequence,
  );
}

export function deleteCue(sequenceId: number, cueId: number): void {
  const command: types.CueCommand = {
    type: "DeleteCue",
    data: {
      sequence_id: sequenceId,
      cue_id: cueId,
    },
  };

  engineRuntime.sendCommand({
    module: "CueCommand",
    command,
  });

  log.info(`Deleted cue ${sequenceId}.${cueId}`);
}

export function deleteSequence(sequenceId: number): void {
  const command: types.CueCommand = {
    type: "DeleteSequence",
    data: sequenceId,
  };

  engineRuntime.sendCommand({
    module: "CueCommand",
    command,
  });

  log.info(`Deleted sequence ${sequenceId}`);
}

// Cue Preview commands
/** Sends a cue snapshot to the backend preview renderer. */
export async function previewCue(
  cue: types.Cue,
  instanceId?: types.InstanceId,
): Promise<types.InstanceId> {
  const command: types.CuePreviewCommand = {
    type: "PreviewCue",
    data: {
      ...(instanceId !== undefined ? { instance_id: instanceId } : {}),
      cue,
    },
  };
  const result = await engineRuntime.sendCommandAndAwait({
    module: "CuePreviewCommand",
    command,
  });
  const returnedInstanceId = instanceIdFromResult(result);
  log.info(`Updated cue preview for ${cue.identifiers.label}`);
  return returnedInstanceId;
}

/**
 * Sends a sequence preview snapshot to replace the current preview instance.
 */
export async function previewSequence(
  payload: types.SequencePreview,
  instanceId?: types.InstanceId,
): Promise<types.InstanceId> {
  const command: types.CuePreviewCommand = {
    type: "PreviewSequence",
    data: {
      ...(instanceId !== undefined ? { instance_id: instanceId } : {}),
      preview: payload,
    },
  };
  const result = await engineRuntime.sendCommandAndAwait({
    module: "CuePreviewCommand",
    command,
  });
  const returnedInstanceId = instanceIdFromResult(result);
  log.info(
    `Updated sequence preview for ${payload.sequence.identifiers.label}`,
  );
  return returnedInstanceId;
}

/** Assigns preview transition time, pausing for inspection or resuming playback. */
export async function seekPreviewInstance(
  instanceId: types.InstanceId,
  positionSeconds: number,
  playing: boolean,
): Promise<void> {
  const milliseconds = Math.round(Math.max(0, positionSeconds) * 1000);
  const command: types.CuePreviewCommand = {
    type: "SeekPreview",
    data: {
      instance_id: instanceId,
      position: {
        secs: Math.floor(milliseconds / 1000),
        nanos: (milliseconds % 1000) * 1_000_000,
      },
      playing,
    },
  };
  await engineRuntime.sendCommandAndAwait({
    module: "CuePreviewCommand",
    command,
  });
}

/** Stops the editor preview instance with the given runtime instance ID. */
export async function stopPreviewInstance(
  instanceId: types.InstanceId,
): Promise<void> {
  const command: types.CuePreviewCommand = {
    type: "StopPreview",
    data: { instance_id: instanceId },
  };
  await engineRuntime.sendCommandAndAwait({
    module: "CuePreviewCommand",
    command,
  });
  log.info("Stopped editor preview");
}
