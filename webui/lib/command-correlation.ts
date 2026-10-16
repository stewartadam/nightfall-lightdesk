// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { SelectionFlattenRetry } from "../state/appStores";
import type * as types from "../types";
import { normalizeCorrelationId } from "./console-scrollback";
import {
  abandonPendingCommand,
  type SettledPendingCommand,
  settlePendingCommand,
} from "./pending-command-lifecycle";
import { normalizedShowfileName } from "./showfile-loading";

/** Resolver pair for a caller awaiting one command's terminal result. */
export interface CommandResultWaiter {
  resolve: (result: types.CommandResult) => void;
  reject: (error: Error) => void;
}

/** Showfile name a desk command will make current once it succeeds. */
export interface PendingCurrentShowfileName {
  name: string;
}

/** Pending terminal-result resolvers, keyed by command ID. */
const commandWaiters = new Map<string, CommandResultWaiter>();

/** Retry results can resolve the console entry created for the rejected command. */
const commandResultAliases = new Map<string, string>();

const pendingCurrentShowfileNames = new Map<
  string,
  PendingCurrentShowfileName
>();

const pendingCommandLifecycle = {
  waiters: commandWaiters,
  resultMetadata: pendingCurrentShowfileNames,
};

/** Registers a caller awaiting the terminal result of a submitted command. */
export function registerCommandResultWaiter(
  commandKey: string,
  waiter: CommandResultWaiter,
): void {
  commandWaiters.set(commandKey, waiter);
}

/** Discards the waiter and result metadata of a command that was never submitted. */
export function abandonCommandCorrelation(commandKey: string): void {
  abandonPendingCommand(pendingCommandLifecycle, commandKey);
}

/** Consumes the waiter and result metadata of a command whose result arrived. */
export function settleCommandCorrelation(
  commandKey: string,
): SettledPendingCommand<CommandResultWaiter, PendingCurrentShowfileName> {
  return settlePendingCommand(pendingCommandLifecycle, commandKey);
}

/** Routes the result of an approved retry to the console entry of the rejected command. */
export function aliasCommandResult(
  retryCommandId: string,
  rejectedCorrelationId: string,
): void {
  commandResultAliases.set(
    normalizeCorrelationId(retryCommandId),
    normalizeCorrelationId(rejectedCorrelationId),
  );
}

/** Returns the console correlation key a result should update, consuming any retry alias. */
export function takeCommandResultDisplayKey(correlationKey: string): string {
  const displayCorrelationKey =
    commandResultAliases.get(correlationKey) ?? correlationKey;
  commandResultAliases.delete(correlationKey);
  return displayCorrelationKey;
}

/** Rejects terminal-result waiters when their transport session ends. */
export function rejectPendingCommandWaiters(error: Error): void {
  const waiters = [...commandWaiters.values()];
  commandWaiters.clear();
  commandResultAliases.clear();
  pendingCurrentShowfileNames.clear();
  for (const waiter of waiters) {
    waiter.reject(error);
  }
}

/** Extracts the current showfile name implied by a successful desk command. */
function currentShowfileNameFromCommand(
  data: object,
): PendingCurrentShowfileName | null {
  const envelope = data as {
    module?: unknown;
    command?: { type?: unknown; data?: unknown };
  };
  if (envelope.module !== "DeskCommand") {
    return null;
  }

  const command = envelope.command;
  switch (command?.type) {
    case "NewShowfile":
    case "LoadShowfile":
      return { name: "default" };
    case "NewNamedShowfile":
      return command.data &&
        typeof command.data === "object" &&
        "name" in command.data &&
        typeof command.data.name === "string"
        ? {
            name: normalizedShowfileName(command.data.name),
          }
        : null;
    case "LoadNamedShowfile":
    case "LoadDraftShowfile":
    case "SaveNamedShowfile":
      return typeof command.data === "string"
        ? {
            name: normalizedShowfileName(command.data),
          }
        : null;
    case "LoadShowfileRevision":
      return command.data &&
        typeof command.data === "object" &&
        "showfileName" in command.data &&
        typeof command.data.showfileName === "string"
        ? {
            name: normalizedShowfileName(command.data.showfileName),
          }
        : null;
    default:
      return null;
  }
}

/** Defers a showfile-name update until the correlated command succeeds. */
export function registerPendingCurrentShowfileName(
  correlationId: string,
  data: object,
): void {
  const showfileUpdate = currentShowfileNameFromCommand(data);
  if (showfileUpdate) {
    pendingCurrentShowfileNames.set(
      normalizeCorrelationId(correlationId),
      showfileUpdate,
    );
  }
}

/** Extracts a validated selection-flatten retry from a structured command failure. */
export function selectionFlattenRetryFromResult(
  result: types.CommandResult,
): SelectionFlattenRetry | null {
  if (
    result.outcome.type !== "Failed" ||
    result.outcome.data.code !==
      "programmer.selection_flatten_confirmation_required"
  ) {
    return null;
  }
  const details = result.outcome.data.details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const retry = details as {
    module?: unknown;
    command?: {
      type?: unknown;
      data?: {
        allow_selection_flatten?: unknown;
        selection_flatten_approval?: unknown;
      };
    };
  };
  const hasApproval =
    typeof retry.command?.data?.selection_flatten_approval === "string" &&
    retry.command.data.selection_flatten_approval.length > 0;
  const isApprovedProgrammerRelease =
    retry.module === "ProgrammerCommand" &&
    retry.command?.type === "ReleaseProgrammerValues" &&
    retry.command.data?.allow_selection_flatten === true &&
    hasApproval;
  const isApprovedUserCommand =
    retry.module === "UserCommand" &&
    (retry.command?.type === "Clear" || retry.command?.type === "Release") &&
    retry.command.data?.allow_selection_flatten === true &&
    hasApproval;
  if (!isApprovedProgrammerRelease && !isApprovedUserCommand) {
    return null;
  }
  return retry as SelectionFlattenRetry;
}
