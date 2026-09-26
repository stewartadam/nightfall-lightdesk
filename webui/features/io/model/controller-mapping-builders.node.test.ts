// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types";
import { describeBinding } from "./binding-behaviors";
import {
  midiMappingFromEvent,
  type OscGesture,
  oscBindingProblem,
  oscMappingFromGesture,
  oscMappingReportsRelease,
  parseBehavior,
  trackOscGesture,
} from "./controller-mapping-builders";

const ACTION: types.ActionReference = { id: "clip.go", arguments: {} };
const { Press, Release, Hold, Flash } = types.ControlBehavior;
const { Trigger, Absolute } = types.ActionInputKind;

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

/** Returns the argument criteria of a mapping built for a touch, action kind, and behavior. */
function criteria(
  gesture: OscGesture,
  kind: types.ActionInputKind,
  behavior: types.ControlBehavior = Press,
): Pick<types.OscMapping, "arg_index" | "arg_value" | "release_value"> {
  const { arg_index, arg_value, release_value } = oscMappingFromGesture(
    gesture,
    ACTION,
    kind,
    behavior,
  );
  return { arg_index, arg_value, release_value };
}

const ONE = oscEvent({ type: "Int", data: 1 });
const ZERO = oscEvent({ type: "Int", data: 0 });
const READS_ARGUMENT = {
  arg_index: 0,
  arg_value: undefined,
  release_value: undefined,
};
const BUTTON_VALUES = { arg_index: 0, arg_value: "1", release_value: "0" };

/** Argument-free messages are pulses. */
test("argument-free OSC messages map as pulses", () => {
  assert.deepEqual(criteria(gestureOf(oscEvent()), Trigger), {
    arg_index: undefined,
    arg_value: undefined,
    release_value: undefined,
  });
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

/** Press triggers match the touched value, and turn a recorded release into edges. */
test("press triggers match the touched values", () => {
  assert.deepEqual(criteria(gestureOf(ONE, ZERO), Trigger), BUTTON_VALUES);
  assert.deepEqual(
    criteria(gestureOf(oscEvent({ type: "Float", data: 0.75 })), Trigger),
    { arg_index: 0, arg_value: "0.75", release_value: undefined },
  );
});

/** Release, Hold, and Flash use recorded button values, or read the argument as a level. */
test("release behaviors use button values or levels", () => {
  for (const [behavior, kind] of [
    [Release, Trigger],
    [Hold, Trigger],
    [Flash, Absolute],
  ] as const) {
    assert.deepEqual(
      criteria(gestureOf(ONE, ZERO), kind, behavior),
      BUTTON_VALUES,
    );
    assert.deepEqual(criteria(gestureOf(ONE), kind, behavior), READS_ARGUMENT);
  }
});

/** Faders driving absolute actions and boolean arguments read the first argument. */
test("faders and booleans read the first argument", () => {
  assert.deepEqual(criteria(gestureOf(ONE, ZERO), Absolute), READS_ARGUMENT);
  assert.deepEqual(
    criteria(gestureOf(oscEvent({ type: "Bool", data: true })), Trigger),
    READS_ARGUMENT,
  );
});

/** Only mappings that read an argument or name a release value report releases. */
test("release reporting follows the argument criteria", () => {
  const touch = gestureOf(ONE, ZERO);
  assert.equal(
    oscMappingReportsRelease(oscMappingFromGesture(touch, ACTION, Trigger)),
    true,
  );
  assert.equal(
    oscMappingReportsRelease(
      oscMappingFromGesture(gestureOf(ONE), ACTION, Trigger),
    ),
    false,
  );
});

/** MIDI mappings carry the chosen behavior, and edited cells parse behaviors in any case. */
test("MIDI mappings carry the chosen behavior", () => {
  const mapping = midiMappingFromEvent(
    {
      device: "Pad",
      source: { type: "Note", data: { channel: 0, note: 60 } },
    } as types.MidiLastEvent,
    ACTION,
    Hold,
  );
  assert.equal(mapping?.behavior, Hold);
  assert.equal(parseBehavior(" flash "), Flash);
  assert.equal(parseBehavior("sometimes"), undefined);
});

/** Binding previews spell out both halves of Hold and Flash. */
test("binding descriptions name what each edge does", () => {
  const binding = {
    control: "Pad 60",
    action: "Start clip Intro",
    inputKind: Trigger,
  };
  assert.equal(
    describeBinding({
      ...binding,
      behavior: Hold,
      releaseAction: "Stop clip Intro",
    }),
    "Holding Pad 60 runs Start clip Intro; letting go runs Stop clip Intro.",
  );
  assert.equal(
    describeBinding({ ...binding, behavior: Release }),
    "Releasing Pad 60 runs Start clip Intro.",
  );
  assert.equal(
    describeBinding({
      ...binding,
      action: "Master level",
      inputKind: Absolute,
      behavior: Flash,
    }),
    "Holding Pad 60 pushes Master level to full; letting go restores it.",
  );
});

/** Binding problems are explained from what the touched OSC control actually sent. */
test("OSC binding problems describe what the control sent", () => {
  const fader = { id: "control.level", arguments: { control_index: 1 } };
  const problem = (
    gesture: OscGesture,
    kind: types.ActionInputKind,
    behavior: types.ControlBehavior,
  ) => oscBindingProblem(gesture, fader, kind, behavior, "Control level 1");

  assert.equal(
    problem(gestureOf(oscEvent()), Absolute, Press),
    "OSC /go sent no value, so it can't set Control level 1. Send a number, such as 0.5.",
  );
  assert.equal(
    problem(
      gestureOf(oscEvent({ type: "String", data: "up" })),
      Absolute,
      Press,
    ),
    "OSC /go sent a String value, not a number, so it can't set Control level 1. Send a number, such as 0.5.",
  );
  assert.equal(
    problem(gestureOf(oscEvent({ type: "Float", data: 0.5 })), Absolute, Press),
    undefined,
  );
  assert.equal(
    problem(gestureOf(oscEvent()), Trigger, Hold),
    "OSC /go sent no value, so there is no way to tell when it is released. Send a value on press and another on release, such as 1 then 0.",
  );
  assert.equal(problem(gestureOf(ONE, ZERO), Trigger, Hold), undefined);
});
