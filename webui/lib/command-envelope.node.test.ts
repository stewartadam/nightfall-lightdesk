// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { commandEnvelope } from "./command-envelope";

test("commandEnvelope includes undo metadata when supplied", () => {
  const command = { type: "DeleteFixture", data: 12 };

  assert.deepEqual(
    commandEnvelope(
      "FixtureCommand",
      command,
      "3e7e02d5-85ab-4878-814e-cdf8c20dbca1",
    ),
    {
      undo_id: "3e7e02d5-85ab-4878-814e-cdf8c20dbca1",
      module: "FixtureCommand",
      command,
    },
  );
});

test("commandEnvelope omits undo metadata when absent", () => {
  const command = { type: "DeleteSceneObject", data: 34 };

  assert.deepEqual(commandEnvelope("SceneObjectCommand", command), {
    module: "SceneObjectCommand",
    command,
  });
});
