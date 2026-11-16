// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { pushToast } from "../../state/appStores";
import { applyDraftSaveStatusSnapshot } from "../../state/draft-save-status";
import { toastActionButtons } from "../../state/toast-actions";
import type * as types from "../../types";
import { decodeCorrelationId } from "../console-scrollback";
import { renameSessionLayoutShowfile } from "../layoutStorage";
import { backendLogConfigToUi } from "../log-config-bridge";
import { configure as configureUiLogging, getLogger } from "../logger";
import {
  applyConfirmedShowfileChange,
  normalizedShowfileName,
} from "../showfile-loading";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);

/** Registers log command echo and backend UI notification handlers. */
export function registerDeskHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("LogCommand", (message) => {
    handleLogCommand(message.data as unknown as types.LogCommand);
  });

  registry.register("UiNotification", (message) => {
    handleUiNotification(message.data as unknown as types.UiNotification);
  });

  registry.register("DraftSaveStatus", (message) => {
    applyDraftSaveStatusSnapshot(message.data);
  });
}

/** Keeps UI-side logging configuration synchronized with log commands from the backend. */
function handleLogCommand(command: types.LogCommand) {
  log.trace("Handling LogCommand:", command);

  switch (command.type) {
    case "SetLogLevel": {
      // Keep UI logging in sync with backend `log level ...` commands.
      configureUiLogging(backendLogConfigToUi(command.data), false);
      break;
    }
    default:
      log.warn(`Unhandled LogCommand: ${command.type}`);
  }
}

/** Applies backend UI notifications such as toast presentation requests. */
function handleUiNotification(notification: types.UiNotification) {
  log.trace("Handling UiNotification:", notification);

  switch (notification.type) {
    case "ShowToast": {
      const level = notification.data.level.toLowerCase();
      const actions = toastActionButtons(notification.data.actions);
      const toastLevel =
        level === "error" || level === "warning" || level === "success"
          ? level
          : "info";
      // A problem the operator can act on stays until dismissed so it isn't missed mid-show.
      const sticky =
        notification.data.sticky === true ||
        (actions.length > 0 &&
          (toastLevel === "warning" || toastLevel === "error"));
      pushToast(
        toastLevel,
        notification.data.message,
        sticky ? -1 : undefined,
        actions,
      );
      break;
    }
    case "CurrentShowfileChanged": {
      const changeId = decodeCorrelationId(notification.data.change_id);
      if (!changeId) {
        log.error("Current showfile notification has an invalid change ID");
        break;
      }
      if (notification.data.renamed_from != null)
        renameSessionLayoutShowfile(
          normalizedShowfileName(notification.data.renamed_from),
          normalizedShowfileName(notification.data.name),
        );
      applyConfirmedShowfileChange(notification.data.name, changeId);
      break;
    }
  }
}
