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

/** Builds a MIDI mapping binding one edge of the control that sent an event to an action. */
export function midiMappingFromEvent(
  event: types.MidiLastEvent,
  action: types.ActionReference,
  edge: types.SourceEdge = types.SourceEdge.Press,
): types.MidiMapping | undefined {
  if (!event.source) return undefined;
  return {
    id: newMappingId(),
    device_name: event.device,
    source: event.source,
    edge,
    action: plain(action),
  };
}

/**
 * Returns the backend match string for a scalar OSC argument, or undefined for other types.
 *
 * Mirrors `OscType::as_match_value` for the argument types button-style senders use.
 */
export function oscMatchValue(
  arg: types.OscType | undefined,
): string | undefined {
  if (!arg) return undefined;
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

/** Formats the edge a mapping fires on for grid display; mappings default to press. */
export function formatSourceEdge(edge: types.SourceEdge | undefined): string {
  return edge === types.SourceEdge.Release ? "Release" : "Press";
}

/** Parses an edited "Fires On" cell, accepting `press` or `release` in any case. */
export function parseSourceEdge(value: string): types.SourceEdge | undefined {
  switch (value.trim().toLowerCase()) {
    case "press":
      return types.SourceEdge.Press;
    case "release":
      return types.SourceEdge.Release;
    default:
      return undefined;
  }
}

/**
 * Returns whether an OSC mapping's messages report the control being released.
 *
 * Mirrors the backend rule for release bindings: a mapping reports edges when it names a
 * release value, or reads an argument as a level or boolean without matching a value.
 */
export function oscMappingReportsRelease(mapping: types.OscMapping): boolean {
  return (
    mapping.release_value !== undefined ||
    (mapping.arg_value === undefined && mapping.arg_index !== undefined)
  );
}

/** One touch of an OSC control: the first message, and a later message with another value. */
export interface OscGesture {
  /** First message of the touch, which carries the pressed value. */
  event: types.OscLastEvent;
  /** First later message on the same address with a different value, such as a release. */
  releaseEvent?: types.OscLastEvent;
}

/**
 * Folds a received OSC message into the gesture being captured.
 *
 * Messages on another address start a new gesture. Senders are not compared, because many
 * send each message from a fresh port and new mappings match any sender. On the same
 * address, the first message with a different first argument is kept as the release, so a
 * button sending `1` then `0` records both values regardless of which arrived last.
 */
export function trackOscGesture(
  gesture: OscGesture | undefined,
  event: types.OscLastEvent,
): OscGesture {
  if (!gesture || gesture.event.address !== event.address) {
    return { event };
  }
  if (
    gesture.releaseEvent ||
    oscMatchValue(event.args[0]) === oscMatchValue(gesture.event.args[0])
  ) {
    return gesture;
  }
  return { ...gesture, releaseEvent: event };
}

/**
 * Builds an OSC mapping binding one edge of the control that sent a gesture to an action.
 *
 * The argument criteria depend on what the action consumes:
 * - Absolute actions and boolean arguments read the first argument as a level or button.
 * - Otherwise the touched value is matched exactly. When the gesture also recorded a
 *   different release value, messages report press and release edges; without one each
 *   matching message is a pulse, so senders that never report a release still fire every
 *   time. Momentary actions without a recorded release read the argument as a level.
 */
export function oscMappingFromGesture(
  gesture: OscGesture,
  action: types.ActionReference,
  inputKind: types.ActionInputKind,
  edge: types.SourceEdge = types.SourceEdge.Press,
): types.OscMapping {
  const mapping: types.OscMapping = {
    id: newMappingId(),
    source: undefined,
    address: gesture.event.address,
    arg_index: undefined,
    arg_value: undefined,
    release_value: undefined,
    edge,
    action: plain(action),
  };
  const [arg] = gesture.event.args;
  if (!arg) return mapping;
  if (inputKind === types.ActionInputKind.Absolute || arg.type === "Bool") {
    return { ...mapping, arg_index: 0 };
  }
  const pressed = oscMatchValue(arg);
  const released = oscMatchValue(gesture.releaseEvent?.args[0]);
  if (pressed === undefined) {
    return inputKind === types.ActionInputKind.Trigger
      ? mapping
      : { ...mapping, arg_index: 0 };
  }
  if (released === undefined && inputKind === types.ActionInputKind.Momentary) {
    return { ...mapping, arg_index: 0 };
  }
  return {
    ...mapping,
    arg_index: 0,
    arg_value: pressed,
    release_value: released,
  };
}
