// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { defineEngineControl } from "./engine-control";

/**
 * Verifies an engine control's handlers and bound action address the same captured target,
 * and that neither the caller's arguments nor an edited action can redirect the handlers.
 */
test("engine controls keep handlers and bindings on one captured target", () => {
  const sent: unknown[] = [];
  const args = { control_index: 3 };
  const control = defineEngineControl({
    id: "control.go",
    label: "Go control 3",
    args,
    handlers: (captured) => ({ go: () => sent.push(captured.control_index) }),
  });

  args.control_index = 9;
  const action = control.action;
  (action.arguments as { control_index: number }).control_index = 7;
  control.handlers.go();

  assert.deepEqual(control.action, {
    id: "control.go",
    arguments: { control_index: 3 },
  });
  assert.deepEqual(sent, [3]);
});

/** Verifies a mapping-only choice has no handlers and keeps its offered behaviors. */
test("mapping-only engine controls have empty handlers", () => {
  const control = defineEngineControl({
    id: "master.on",
    label: "On while held",
    args: { master: "uid" },
    behaviors: [],
  });

  assert.deepEqual(control.handlers, {});
  assert.deepEqual(control.behaviors, []);
});
