// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import { CommandClient, type CommandTransport } from "./command-client";
import {
  CommandSequenceRunner,
  splitCommandSequence,
} from "./command-sequence";

/** Creates one semantic command result for sequence-runner tests. */
function result(
  commandId: string,
  outcome: types.CommandOutcome,
): types.CommandResult {
  return { command_id: commandId, outcome };
}

test("splitCommandSequence preserves quoted semicolons", async () => {
  assert.deepEqual(
    await splitCommandSequence(
      'fix 1 "custom;attr" @ 10; sleep 20ms; store cue 1.1',
    ),
    ['fix 1 "custom;attr" @ 10', "sleep 20ms", "store cue 1.1"],
  );
});

test("CommandSequenceRunner awaits each success before submitting the next", async () => {
  const submissions: string[] = [];
  let releaseFirst: ((value: types.CommandResult) => void) | undefined;
  let markFirstSubmitted: (() => void) | undefined;
  const firstSubmitted = new Promise<void>((resolve) => {
    markFirstSubmitted = resolve;
  });
  const transport: CommandTransport = {
    sendCommandAndAwait: async (data) => {
      const statement = (data as { command: { data: string } }).command.data;
      submissions.push(statement);
      if (submissions.length === 1) {
        markFirstSubmitted?.();
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return result("second", {
        type: "Succeeded",
        data: {},
      });
    },
  };
  const execution = new CommandSequenceRunner(new CommandClient(transport)).run(
    "fix 311 red @ 100; store cue 11.1",
  );

  await firstSubmitted;
  assert.deepEqual(submissions, ["fix 311 red @ 100"]);
  releaseFirst?.(result("first", { type: "Succeeded", data: {} }));
  const completed = await execution;

  assert.deepEqual(submissions, ["fix 311 red @ 100", "store cue 11.1"]);
  assert.equal(completed.steps.length, 2);
  assert.equal(completed.stoppedOnFailure, false);
});

test("CommandSequenceRunner stops after the first command failure", async () => {
  const submissions: string[] = [];
  const transport: CommandTransport = {
    sendCommandAndAwait: async (data) => {
      submissions.push((data as { command: { data: string } }).command.data);
      return result("failed", {
        type: "Failed",
        data: { code: "test.failed", message: "failed", details: null },
      });
    },
  };
  const completed = await new CommandSequenceRunner(
    new CommandClient(transport),
  ).run("bad command; store cue 11.1");

  assert.deepEqual(submissions, ["bad command"]);
  assert.equal(completed.stoppedOnFailure, true);
});
