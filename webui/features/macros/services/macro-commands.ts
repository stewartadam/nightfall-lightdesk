// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { commandClient } from "../../../lib/engine-commands";
import {
  splitCommandStatements,
  validateCommand,
} from "../../../lib/wasm-bridge";
import type * as types from "../../../types";
import { type MacroLineProblem, macroBodyLines } from "../model/macro-model";

/**
 * Sends one macro command to the engine without waiting. A start finishes only when the run
 * ends, and a failed run reaches the operator as an error toast naming the line.
 */
export function sendMacroCommand(command: types.MacroCommand): void {
  commandClient.emit("MacroCommand", command);
}

/**
 * Checks every statement of a macro body against the command grammar, the same way the engine
 * splits the body when it runs. Resolves with one problem per rejected statement, in order.
 */
export async function findMacroBodyProblems(
  body: string,
): Promise<MacroLineProblem[]> {
  const problems: MacroLineProblem[] = [];
  for (const { line, text } of macroBodyLines(body)) {
    const statements = (await splitCommandStatements(text)) ?? [text];
    for (const statement of statements) {
      const result = await validateCommand(statement);
      if (result && result.status !== "ok") {
        problems.push({
          line,
          statement,
          message: result.message ?? "Invalid command.",
        });
      }
    }
  }
  return problems;
}
