// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type * as types from "../../../types";
import {
  $mappingMode,
  armMidiTouches,
  armOscTouches,
  describeMappingPause,
  disarmMappingSource,
  enterMappingMode,
  exitMappingMode,
  mappingModeCommand,
  observeShowGeneration,
} from "./mapping-mode";

/** Builds a MIDI touch from a note control on the E2E pad. */
function midiTouch(note: number, velocity = 127): types.MidiLastEvent {
  return {
    device: "Pad",
    channel: 0x90,
    note,
    velocity,
    source: { type: "Note", data: { channel: 0, note } },
  };
}

/** Builds an OSC touch on `address` carrying one float argument. */
function oscTouch(address: string, value: number): types.OscLastEvent {
  return {
    source: "127.0.0.1:9000",
    address,
    args: [{ type: "Float", data: value }],
  };
}

afterEach(() => {
  exitMappingMode();
});

/**
 * Verifies mapping mode remembers the show generation it entered under, survives binding a
 * control, and ends when the backend reports a new generation after a show load.
 */
test("observeShowGeneration leaves mapping mode when a show load changes the generation", () => {
  assert.equal(observeShowGeneration("show-a"), false);

  enterMappingMode();
  assert.equal(observeShowGeneration(""), false);
  assert.equal(observeShowGeneration("show-a"), false);
  armMidiTouches([midiTouch(60)]);
  disarmMappingSource();
  assert.equal(observeShowGeneration("show-a"), false);
  assert.equal($mappingMode.get().active, true);

  assert.equal(observeShowGeneration("show-b"), true);
  assert.deepEqual($mappingMode.get(), { active: false });
});

/** Verifies the backend command names the requested mapping mode change. */
test("mappingModeCommand enters, renews, and leaves backend mapping mode", () => {
  assert.deepEqual(mappingModeCommand("enter"), {
    module: "ActionCommand",
    command: { type: "EnterControllerMappingMode" },
  });
  assert.deepEqual(mappingModeCommand("renew").command, {
    type: "RenewControllerMappingMode",
  });
  assert.deepEqual(mappingModeCommand("leave").command, {
    type: "LeaveControllerMappingMode",
  });
});

/** Verifies touches only arm while this client is in mapping mode. */
test("touches arm nothing outside mapping mode", () => {
  armMidiTouches([midiTouch(60)]);
  armOscTouches([oscTouch("/a", 1)]);

  assert.equal($mappingMode.get().armed, undefined);
});

/** Verifies the last mappable MIDI control in a batch is armed and unmappable ones skipped. */
test("armMidiTouches arms the last mappable control of a batch", () => {
  enterMappingMode();
  armMidiTouches([
    midiTouch(60),
    midiTouch(61),
    { ...midiTouch(62), source: undefined },
  ]);

  const armed = $mappingMode.get().armed;
  assert.equal(armed?.kind, "midi");
  assert.equal(armed?.event.note, 61);
});

/** Verifies a press and release delivered in one batch both reach the OSC gesture. */
test("armOscTouches records the press and release of one batch", () => {
  enterMappingMode();
  armOscTouches([oscTouch("/button", 1), oscTouch("/button", 0)]);

  const armed = $mappingMode.get().armed;
  assert.equal(armed?.kind, "osc");
  assert.equal(armed?.kind === "osc" && armed.event.args[0]?.data, 1);
  assert.equal(armed?.kind === "osc" && armed.releaseEvent?.args[0]?.data, 0);
});

/** Verifies a just-bound control's trailing touches do not re-arm it, but others do. */
test("a just-bound control's trailing touches do not re-arm it", () => {
  enterMappingMode();
  armOscTouches([oscTouch("/button", 1)]);
  disarmMappingSource();

  armOscTouches([oscTouch("/button", 0)]);
  assert.equal($mappingMode.get().armed, undefined);

  armOscTouches([oscTouch("/other", 1)]);
  const armed = $mappingMode.get().armed;
  assert.equal(armed?.kind === "osc" && armed.event.address, "/other");
});

/**
 * Verifies the pause text counts only other clients when this one is mapping, and says
 * when the backend has not confirmed this client's pause yet.
 */
test("describeMappingPause explains who paused controller actions", () => {
  assert.equal(describeMappingPause(0, false), undefined);
  assert.match(describeMappingPause(1, false) ?? "", /while 1 client is/);
  assert.match(describeMappingPause(3, false) ?? "", /while 3 clients are/);
  assert.equal(describeMappingPause(0, true), "Pausing MIDI and OSC actions…");
  assert.equal(
    describeMappingPause(1, true),
    "MIDI and OSC actions are paused.",
  );
  assert.match(describeMappingPause(2, true) ?? "", /1 other client is/);
});
