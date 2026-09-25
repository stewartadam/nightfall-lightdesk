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

/** Builds a MIDI mapping binding the control that sent an event to an action and behavior. */
export function midiMappingFromEvent(
  event: types.MidiLastEvent,
  action: types.ActionReference,
  behavior: types.ControlBehavior = types.ControlBehavior.Press,
): types.MidiMapping | undefined {
  if (!event.source) return undefined;
  return {
    id: newMappingId(),
    device_name: event.device,
    source: event.source,
    behavior,
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

/** Formats a mapping's behavior for grid display; mappings default to Press. */
export function formatBehavior(
  behavior: types.ControlBehavior | undefined,
): string {
  return behavior ?? types.ControlBehavior.Press;
}

/** Parses an edited Behavior cell, accepting a behavior name in any case. */
export function parseBehavior(
  value: string,
): types.ControlBehavior | undefined {
  const name = value.trim().toLowerCase();
  return Object.values(types.ControlBehavior).find(
    (behavior) => behavior.toLowerCase() === name,
  );
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
 * Builds an OSC mapping binding the control that sent a gesture to an action and behavior.
 *
 * The argument criteria depend on the behavior and what the action consumes:
 * - Boolean arguments, and faders driving absolute actions, read the first argument.
 * - A Press trigger matches the touched value exactly, so senders that never report a
 *   release still fire every time; a recorded release value turns matches into edges.
 * - Other behaviors need releases: they match the recorded pressed and released values,
 *   or read the first argument as a level crossing the press threshold.
 */
export function oscMappingFromGesture(
  gesture: OscGesture,
  action: types.ActionReference,
  inputKind: types.ActionInputKind,
  behavior: types.ControlBehavior = types.ControlBehavior.Press,
): types.OscMapping {
  const mapping: types.OscMapping = {
    id: newMappingId(),
    source: undefined,
    address: gesture.event.address,
    arg_index: undefined,
    arg_value: undefined,
    release_value: undefined,
    behavior,
    action: plain(action),
  };
  const [arg] = gesture.event.args;
  if (!arg) return mapping;
  const press = behavior === types.ControlBehavior.Press;
  const pressed = oscMatchValue(arg);
  const released = oscMatchValue(gesture.releaseEvent?.args[0]);
  const readsArgument =
    arg.type === "Bool" ||
    (press && inputKind === types.ActionInputKind.Absolute) ||
    pressed === undefined ||
    (!press && released === undefined);
  if (readsArgument) {
    return press &&
      inputKind === types.ActionInputKind.Trigger &&
      pressed === undefined &&
      arg.type !== "Bool"
      ? mapping
      : { ...mapping, arg_index: 0 };
  }
  return {
    ...mapping,
    arg_index: 0,
    arg_value: pressed,
    release_value: released,
  };
}
