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

/** One transport call recorded by the fake transport. */
interface RecordedSend {
  kind: "emit" | "invoke";
  data: object;
  consoleCommandText?: string;
}

/** Builds a transport that records every envelope and answers with fixed values. */
function recordingTransport(sent: RecordedSend[]): CommandTransport {
  return {
    sendCommand: (data, consoleCommandText) => {
      sent.push({ kind: "emit", data, consoleCommandText });
      return "command-1";
    },
    sendCommandAndAwait: async (data, consoleCommandText) => {
      sent.push({ kind: "invoke", data, consoleCommandText });
      return {
        command_id: "command-2",
        outcome: { type: "Succeeded", data: {} },
      } as unknown as types.CommandResult;
    },
  };
}

/** Verifies emit wraps the command in an envelope and returns the transport's id synchronously. */
test("CommandClient.emit sends an envelope without waiting", () => {
  const sent: RecordedSend[] = [];
  const client = new CommandClient(recordingTransport(sent));

  const commandId = client.emit("CueCommand", { type: "Go" });

  assert.equal(commandId, "command-1");
  assert.deepEqual(sent, [
    {
      kind: "emit",
      data: { module: "CueCommand", command: { type: "Go" } },
      consoleCommandText: undefined,
    },
  ]);
});

/** Verifies invoke forwards undo grouping and console text and resolves with the result. */
test("CommandClient.invoke forwards undo id and console text", async () => {
  const sent: RecordedSend[] = [];
  const client = new CommandClient(recordingTransport(sent));

  const result = await client.invoke(
    "DeskCommand",
    { type: "Eval", data: "clear" },
    { undoId: "batch-1", consoleCommandText: "clear" },
  );

  assert.equal(result.command_id, "command-2");
  assert.deepEqual(sent, [
    {
      kind: "invoke",
      data: {
        undo_id: "batch-1",
        module: "DeskCommand",
        command: { type: "Eval", data: "clear" },
      },
      consoleCommandText: "clear",
    },
  ]);
});
