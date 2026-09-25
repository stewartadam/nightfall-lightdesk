// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as types from "../../../types";

/** Creates a stable mapping ID in the simple UUID form the backend accepts. */
export function newMappingId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Deep clones a value into a plain object that can be posted to the worker. */
export function plain<T>(value: T): T {
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

/**
 * Returns the backend match string for a scalar OSC argument, or undefined for other types.
 *
 * Mirrors `OscType::as_match_value` for the argument types button-style senders use.
 */
function oscMatchValue(arg: types.OscType): string | undefined {
  switch (arg.type) {
    case "Int":
    case "Float":
    case "Double":
    case "Long":
    case "String":
      return String(arg.data);
    default:
      return undefined;
  }
}

/**
 * Builds an OSC mapping binding the address that sent an event to an action.
 *
 * The argument criteria depend on what the action consumes:
 * - Absolute and momentary actions read the first argument as a level or button state.
 * - Boolean arguments report press and release edges.
 * - Trigger actions fire on each message whose first argument equals the touched value, so a
 *   sender reporting `1` on press and `0` on release fires once per press, and a sender that
 *   never reports a release still fires every time.
 */
export function oscMappingFromEvent(
  event: types.OscLastEvent,
  action: types.ActionReference,
  inputKind: types.ActionInputKind,
): types.OscMapping {
  const mapping: types.OscMapping = {
    id: newMappingId(),
    source: undefined,
    address: event.address,
    arg_index: undefined,
    arg_value: undefined,
    action: plain(action),
  };
  const [arg] = event.args;
  if (!arg) return mapping;
  if (inputKind !== types.ActionInputKind.Trigger || arg.type === "Bool") {
    return { ...mapping, arg_index: 0 };
  }
  const value = oscMatchValue(arg);
  return value === undefined
    ? mapping
    : { ...mapping, arg_index: 0, arg_value: value };
}
