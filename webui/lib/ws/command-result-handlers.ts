// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  addExternalConsoleCommand,
  applyConsoleCommandResult,
  pushToast,
  requestSelectionFlattenConfirmation,
} from "../../state/appStores";
import type * as types from "../../types";
import {
  selectionFlattenRetryFromResult,
  settleCommandCorrelation,
  takeCommandResultDisplayKey,
} from "../command-correlation";
import { consumeCommandFailurePresented } from "../command-failure-toasts";
import { decodeCorrelationId } from "../console-scrollback";
import { getLogger } from "../logger";
import { persistCurrentShowfileName } from "../showfile-loading";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);

/** Registers command result, command notice, and external console command handlers. */
export function registerCommandResultHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("CommandResult", (message) => {
    log.debug("CommandResult received:", message.data);
    handleCommandResult(message.data as types.CommandResult);
  });

  registry.register("CommandNotice", (message) => {
    const notice = message.data as types.CommandNotice;
    pushToast(notice.level === "Warning" ? "warning" : "info", notice.message);
  });

  registry.register("OscExternalEval", (message) => {
    const data = message.data as types.OscExternalEval;
    const correlationId = decodeCorrelationId(data.correlation_id);
    if (!correlationId) {
      log.warn(
        "Ignoring OscExternalEval with invalid correlation_id",
        data.correlation_id,
      );
      return;
    }
    addExternalConsoleCommand(data.command, correlationId, data.source);
  });
}

/**
 * Settles a command's terminal result: resolves its awaiting caller, commits
 * any deferred showfile name, updates console scrollback, and presents
 * failures either as a selection-flatten confirmation or as an error toast.
 */
function handleCommandResult(result: types.CommandResult) {
  // Resolve any pending promise for this command_id.
  const correlationKey = decodeCorrelationId(result.command_id as unknown);

  const settledCommand = correlationKey
    ? settleCommandCorrelation(correlationKey)
    : {};
  const hadWaiter = Boolean(settledCommand.waiter);
  settledCommand.waiter?.resolve(result);

  const flattenRetry = selectionFlattenRetryFromResult(result);
  if (correlationKey) {
    const showfileUpdate = settledCommand.resultMetadata;
    if (showfileUpdate && result.outcome.type === "Succeeded") {
      persistCurrentShowfileName(showfileUpdate.name);
    }
    if (!flattenRetry) {
      applyConsoleCommandResult(
        takeCommandResultDisplayKey(correlationKey),
        result.outcome,
      );
    }
  }

  if (result.outcome.type === "Failed") {
    if (flattenRetry) {
      if (!hadWaiter) {
        requestSelectionFlattenConfirmation(
          flattenRetry,
          correlationKey ?? undefined,
          result.outcome,
        );
      }
    } else if (!consumeCommandFailurePresented(result.command_id)) {
      pushToast("error", result.outcome.data.message);
    }
  }
}
