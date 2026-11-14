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

/** A command sent without waiting, labelled with the caller's key for what it acted on. */
export interface PendingCommand<TKey> {
  key: TKey;
  result: Promise<types.CommandResult>;
}

/**
 * Waits for every pending command and returns the keys of those that failed, whether the
 * backend rejected them or they could not be sent, in the order they were given.
 */
export async function failedCommandKeys<TKey>(
  commands: readonly PendingCommand<TKey>[],
): Promise<TKey[]> {
  const settled = await Promise.allSettled(
    commands.map(({ result }) => result),
  );
  return commands
    .filter((_, index) => {
      const outcome = settled[index];
      return outcome.status === "rejected" || !commandSucceeded(outcome.value);
    })
    .map(({ key }) => key);
}

/** Throws the command's structured failure when the result was not successful. */
export function requireCommandSuccess(result: types.CommandResult): void {
  const failure = commandFailure(result);
  if (failure) {
    throw new Error(failure.message);
  }
}
