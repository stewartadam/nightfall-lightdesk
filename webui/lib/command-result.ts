// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

type SucceededCommandOutcome = Extract<
  types.CommandOutcome,
  { type: "Succeeded" }
>;

/** Returns whether a terminal command result completed successfully. */
export function commandSucceeded(
  result: types.CommandResult,
): result is types.CommandResult & { outcome: SucceededCommandOutcome } {
  return result.outcome.type === "Succeeded";
}

/** Returns the structured failure carried by a failed command result. */
export function commandFailure(
  result: types.CommandResult,
): types.CommandError | null {
  return result.outcome.type === "Failed" ? result.outcome.data : null;
}

/** Returns the operator-facing failure message or a fallback for unexpected success. */
export function commandFailureMessage(
  result: types.CommandResult,
  fallback = "Command failed",
): string {
  return commandFailure(result)?.message ?? fallback;
}

/** Returns the erased domain output value from a successful command result. */
export function commandOutputValue(
  result: types.CommandResult,
): unknown | undefined {
  if (!commandSucceeded(result)) {
    return undefined;
  }
  return result.outcome.data.output?.value;
}

/** Throws the command's structured failure when the result was not successful. */
export function requireCommandSuccess(result: types.CommandResult): void {
  const failure = commandFailure(result);
  if (failure) {
    throw new Error(failure.message);
  }
}
