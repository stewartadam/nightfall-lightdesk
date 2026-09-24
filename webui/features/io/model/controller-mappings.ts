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

/** Creates a stable mapping ID in the simple UUID form the backend accepts. */
export function newMappingId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Deep clones a value into a plain object that can be posted to the worker. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Describes a MIDI control with a one-based channel for display. */
export function midiSourceLabel(source: types.MidiSource): string {
  const channel = `Ch ${source.data.channel + 1}`;
  switch (source.type) {
    case "Note":
      return `Note ${source.data.note} · ${channel}`;
    case "ControlChange":
      return `CC ${source.data.controller} · ${channel}`;
    case "PitchBend":
      return `Pitch bend · ${channel}`;
  }
}

/** Returns the note or controller number of a MIDI control, if it has one. */
export function midiSourceNumber(source: types.MidiSource): number | undefined {
  switch (source.type) {
    case "Note":
      return source.data.note;
    case "ControlChange":
      return source.data.controller;
    case "PitchBend":
      return undefined;
  }
}

/** Returns a copy of a MIDI control with a new zero-based channel. */
export function withMidiChannel(
  source: types.MidiSource,
  channel: number,
): types.MidiSource {
  return { ...source, data: { ...source.data, channel } } as types.MidiSource;
}

/** Returns a copy of a MIDI control with a new note or controller number. */
export function withMidiNumber(
  source: types.MidiSource,
  value: number,
): types.MidiSource {
  switch (source.type) {
    case "Note":
      return { type: "Note", data: { ...source.data, note: value } };
    case "ControlChange":
      return {
        type: "ControlChange",
        data: { ...source.data, controller: value },
      };
    case "PitchBend":
      return source;
  }
}

/** Builds a MIDI mapping binding the control that sent an event to an action. */
export function midiMappingFromEvent(
  event: types.MidiLastEvent,
  action: types.ActionReference,
): types.MidiMapping | undefined {
  if (!event.source) return undefined;
  return {
    id: newMappingId(),
    device_name: event.device,
    source: event.source,
    action: plain(action),
  };
}

/** Builds an OSC mapping binding the address that sent an event to an action. */
export function oscMappingFromEvent(
  event: types.OscLastEvent,
  action: types.ActionReference,
): types.OscMapping {
  return {
    id: newMappingId(),
    source: undefined,
    address: event.address,
    arg_index: event.args.length > 0 ? 0 : undefined,
    arg_value: undefined,
    action: plain(action),
  };
}

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
