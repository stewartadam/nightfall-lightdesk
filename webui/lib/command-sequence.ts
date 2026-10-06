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

/** Observers notified as a sequence advances through its statements. */
export interface CommandSequenceProgress {
  /** Called once a statement has been submitted, before its result arrives. */
  onStatementStarted?: (index: number) => void;
  /** Called once a statement's terminal result has arrived. */
  onStatementSettled?: (index: number, result: types.CommandResult) => void;
}

/** Runs console statements serially with one command and undo identity per statement. */
export class CommandSequenceRunner {
  private readonly client: CommandClient;

  /** Creates a sequence runner over an application-supplied command client. */
  constructor(client: CommandClient) {
    this.client = client;
  }

  /** Splits console input into statements, then submits them in order. */
  async run(
    input: string,
    progress: CommandSequenceProgress = {},
  ): Promise<CommandSequenceResult> {
    return this.runStatements(await splitCommandSequence(input), progress);
  }

  /** Submits already-split statements in order and stops after the first failed command. */
  async runStatements(
    statements: readonly string[],
    progress: CommandSequenceProgress = {},
  ): Promise<CommandSequenceResult> {
    const steps: CommandSequenceStep[] = [];

    for (const [index, statement] of statements.entries()) {
      const command: types.DeskCommand = {
        type: "Eval",
        data: statement,
      };
      const pendingResult = this.client.submitCommand("DeskCommand", command, {
        consoleCommandText: statement,
      });
      progress.onStatementStarted?.(index);
      const result = await pendingResult;
      progress.onStatementSettled?.(index, result);
      steps.push({ statement, result });
      if (result.outcome.type === "Failed") {
        return { steps, stoppedOnFailure: true };
      }
    }

    return { steps, stoppedOnFailure: false };
  }
}
