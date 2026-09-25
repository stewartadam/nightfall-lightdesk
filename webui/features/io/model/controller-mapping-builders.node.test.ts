// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types";
import { oscMappingFromEvent } from "./controller-mapping-builders";

const ACTION: types.ActionReference = { id: "clip.go", arguments: {} };

/** Builds an OSC event from one address and its arguments. */
function oscEvent(...args: types.OscType[]): types.OscLastEvent {
  return { source: "127.0.0.1:9000", address: "/go", args };
}

/** Returns the argument criteria of a mapping built for an event and input kind. */
function criteria(
  event: types.OscLastEvent,
  kind: types.ActionInputKind,
): Pick<types.OscMapping, "arg_index" | "arg_value"> {
  const { arg_index, arg_value } = oscMappingFromEvent(event, ACTION, kind);
  return { arg_index, arg_value };
}

/** Argument-free messages are pulses regardless of the action. */
test("argument-free OSC messages map as pulses", () => {
  assert.deepEqual(criteria(oscEvent(), types.ActionInputKind.Trigger), {
    arg_index: undefined,
    arg_value: undefined,
  });
});

/** Trigger actions match the touched value so releases and integer levels do not misfire. */
test("trigger actions match the touched argument value", () => {
  assert.deepEqual(
    criteria(oscEvent({ type: "Int", data: 1 }), types.ActionInputKind.Trigger),
    { arg_index: 0, arg_value: "1" },
  );
  assert.deepEqual(
    criteria(
      oscEvent({ type: "Float", data: 0.75 }),
      types.ActionInputKind.Trigger,
    ),
    { arg_index: 0, arg_value: "0.75" },
  );
});

/** Boolean arguments report press and release edges for any button-style action. */
test("boolean arguments map as buttons", () => {
  assert.deepEqual(
    criteria(
      oscEvent({ type: "Bool", data: true }),
      types.ActionInputKind.Trigger,
    ),
    { arg_index: 0, arg_value: undefined },
  );
});

/** Absolute and momentary actions read the first argument as a level. */
test("absolute and momentary actions read the first argument", () => {
  for (const kind of [
    types.ActionInputKind.Absolute,
    types.ActionInputKind.Momentary,
  ]) {
    assert.deepEqual(criteria(oscEvent({ type: "Float", data: 0.5 }), kind), {
      arg_index: 0,
      arg_value: undefined,
    });
  }
});
