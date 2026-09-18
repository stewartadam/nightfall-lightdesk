// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import type { CommandClient } from "./command-client";
import { splitCommandStatements } from "./wasm-bridge";

/** One statement and the terminal result observed before the next statement started. */
export interface CommandSequenceStep {
  statement: string;
  result: types.CommandResult;
}

/** Observable outcome of an awaited command sequence. */
export interface CommandSequenceResult {
  steps: CommandSequenceStep[];
  stoppedOnFailure: boolean;
}

/** Splits command statements through the shared Rust command-language parser. */
export async function splitCommandSequence(input: string): Promise<string[]> {
  const statements = await splitCommandStatements(input);
  if (!statements) {
    throw new Error("Command parser is unavailable");
  }
  return statements;
}

/** Runs console statements serially with one command and undo identity per statement. */
export class CommandSequenceRunner {
  private readonly client: CommandClient;

  /** Creates a sequence runner over an application-supplied command client. */
  constructor(client: CommandClient) {
    this.client = client;
  }

  /** Submits statements in order and stops after the first failed command. */
  async run(input: string): Promise<CommandSequenceResult> {
    const statements = await splitCommandSequence(input);
    const steps: CommandSequenceStep[] = [];

    for (const statement of statements) {
      const command: types.DeskCommand = {
        type: "Eval",
        data: statement,
      };
      const result = await this.client.submitCommand("DeskCommand", command, {
        consoleCommandText: statement,
      });
      steps.push({ statement, result });
      if (result.outcome.type === "Failed") {
        return { steps, stoppedOnFailure: true };
      }
    }

    return { steps, stoppedOnFailure: false };
  }
}
