// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types";
import {
  midiMappingFromEvent,
  type OscGesture,
  oscMappingFromGesture,
  oscMappingReportsRelease,
  parseSourceEdge,
  trackOscGesture,
} from "./controller-mapping-builders";

const ACTION: types.ActionReference = { id: "clip.go", arguments: {} };

/** Builds an OSC event from one address and its arguments. */
function oscEvent(...args: types.OscType[]): types.OscLastEvent {
  return { source: "127.0.0.1:9000", address: "/go", args };
}

/** Folds a sequence of OSC messages into one captured touch. */
function gestureOf(...events: types.OscLastEvent[]): OscGesture {
  let gesture: OscGesture | undefined;
  for (const event of events) gesture = trackOscGesture(gesture, event);
  assert.ok(gesture);
  return gesture;
}

/** Returns the argument criteria of a mapping built for a touch and input kind. */
function criteria(
  gesture: OscGesture,
  kind: types.ActionInputKind,
): Pick<types.OscMapping, "arg_index" | "arg_value" | "release_value"> {
  const { arg_index, arg_value, release_value } = oscMappingFromGesture(
    gesture,
    ACTION,
    kind,
  );
  return { arg_index, arg_value, release_value };
}

const ONE = oscEvent({ type: "Int", data: 1 });
const ZERO = oscEvent({ type: "Int", data: 0 });

/** Argument-free messages are pulses regardless of the action. */
test("argument-free OSC messages map as pulses", () => {
  assert.deepEqual(
    criteria(gestureOf(oscEvent()), types.ActionInputKind.Trigger),
    { arg_index: undefined, arg_value: undefined, release_value: undefined },
  );
});

/** A touch keeps its first value as the press and the first different value as the release. */
test("touches record pressed and released values in arrival order", () => {
  const touch = gestureOf(ONE, ONE, ZERO, ONE);
  assert.equal(touch.event, ONE);
  assert.equal(touch.releaseEvent, ZERO);
  assert.equal(
    gestureOf(ONE, { ...ZERO, address: "/other" }).event.address,
    "/other",
  );
});

/** Trigger actions report edges when a release was recorded, and pulses otherwise. */
test("trigger actions match the touched values", () => {
  assert.deepEqual(
    criteria(gestureOf(ONE, ZERO), types.ActionInputKind.Trigger),
    { arg_index: 0, arg_value: "1", release_value: "0" },
  );
  assert.deepEqual(
    criteria(
      gestureOf(oscEvent({ type: "Float", data: 0.75 })),
      types.ActionInputKind.Trigger,
    ),
    { arg_index: 0, arg_value: "0.75", release_value: undefined },
  );
});

/** Momentary actions use recorded button values, or read a level without them. */
test("momentary actions use button values or levels", () => {
  assert.deepEqual(
    criteria(gestureOf(ONE, ZERO), types.ActionInputKind.Momentary),
    { arg_index: 0, arg_value: "1", release_value: "0" },
  );
  assert.deepEqual(criteria(gestureOf(ONE), types.ActionInputKind.Momentary), {
    arg_index: 0,
    arg_value: undefined,
    release_value: undefined,
  });
});

/** Absolute actions and boolean arguments read the first argument directly. */
test("absolute actions and booleans read the first argument", () => {
  assert.deepEqual(
    criteria(gestureOf(ONE, ZERO), types.ActionInputKind.Absolute),
    { arg_index: 0, arg_value: undefined, release_value: undefined },
  );
  assert.deepEqual(
    criteria(
      gestureOf(oscEvent({ type: "Bool", data: true })),
      types.ActionInputKind.Trigger,
    ),
    { arg_index: 0, arg_value: undefined, release_value: undefined },
  );
});

/** Release bindings require a mapping whose messages report the release. */
test("release bindings need reported releases", () => {
  const withRelease = oscMappingFromGesture(
    gestureOf(ONE, ZERO),
    ACTION,
    types.ActionInputKind.Trigger,
    types.SourceEdge.Release,
  );
  assert.equal(withRelease.edge, types.SourceEdge.Release);
  assert.equal(oscMappingReportsRelease(withRelease), true);
  const pulseOnly = oscMappingFromGesture(
    gestureOf(ONE),
    ACTION,
    types.ActionInputKind.Trigger,
  );
  assert.equal(oscMappingReportsRelease(pulseOnly), false);
});

/** MIDI mappings carry the chosen edge, and edited cells parse edges in any case. */
test("MIDI mappings carry the chosen edge", () => {
  const mapping = midiMappingFromEvent(
    {
      device: "Pad",
      source: { type: "Note", data: { channel: 0, note: 60 } },
    } as types.MidiLastEvent,
    ACTION,
    types.SourceEdge.Release,
  );
  assert.equal(mapping?.edge, types.SourceEdge.Release);
  assert.equal(parseSourceEdge(" RELEASE "), types.SourceEdge.Release);
  assert.equal(parseSourceEdge("sometimes"), undefined);
});
