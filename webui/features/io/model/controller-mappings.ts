// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  commandFailureMessage,
  commandSucceeded,
} from "../../../lib/command-result";
import { engineRuntime } from "../../../lib/engine-runtime";
import { pushToast } from "../../../state/appStores";
import type * as types from "../../../types";
import { plain } from "./controller-mapping-builders";

/** Sends a mapping command and surfaces rejected bindings as a toast. */
async function submitMappingCommand(
  module: "MidiCommand" | "OscCommand",
  command: types.MidiCommand | types.OscCommand,
): Promise<boolean> {
  const result = await engineRuntime.sendCommandAndAwait({
    module,
    command: plain(command),
  });
  if (!commandSucceeded(result)) {
    pushToast("error", commandFailureMessage(result));
    return false;
  }
  return true;
}

/** Creates or replaces a MIDI mapping; other mappings on the same control are removed. */
export function upsertMidiMapping(
  mapping: types.MidiMapping,
): Promise<boolean> {
  return submitMappingCommand("MidiCommand", {
    type: "UpsertMapping",
    data: mapping,
  });
}

/** Deletes a MIDI mapping by ID. */
export function deleteMidiMapping(id: string): Promise<boolean> {
  return submitMappingCommand("MidiCommand", {
    type: "DeleteMapping",
    data: id,
  });
}

/** Creates or replaces an OSC mapping; mappings with the same criteria are removed. */
export function upsertOscMapping(mapping: types.OscMapping): Promise<boolean> {
  return submitMappingCommand("OscCommand", {
    type: "UpsertMapping",
    data: mapping,
  });
}

/** Deletes an OSC mapping by ID. */
export function deleteOscMapping(id: string): Promise<boolean> {
  return submitMappingCommand("OscCommand", {
    type: "DeleteMapping",
    data: id,
  });
}
