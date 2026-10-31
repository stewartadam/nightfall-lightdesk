// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getLogger } from "../lib/logger";
import type { ToastAction } from "../lib/notification-queue";
import { ToastAction as EngineToastAction } from "../types";

const log = getLogger(import.meta.url);

/** Button text for each follow-up the engine can attach to a toast. */
const LABELS: Record<EngineToastAction, string> = {
  [EngineToastAction.OpenNetworkSettings]: "Open network settings",
  [EngineToastAction.OpenExternalControlSettings]:
    "Open external control settings",
};

const handlers = new Map<EngineToastAction, () => void>();

/**
 * Lets the shell decide what an engine toast action opens. The engine only names the follow-up,
 * and the shell owns the dialogs and panels, so websocket handlers never import UI modules.
 * Returns a function that removes the registration.
 */
export function registerToastActionHandler(
  action: EngineToastAction,
  run: () => void,
): () => void {
  handlers.set(action, run);
  return () => {
    if (handlers.get(action) === run) handlers.delete(action);
  };
}

/**
 * Turns the actions the engine attached to a toast into buttons. Each button looks up its handler
 * when clicked, so toasts replayed before the shell finished mounting still work.
 */
export function toastActionButtons(
  actions: readonly EngineToastAction[] | undefined,
): ToastAction[] {
  return (actions ?? []).map((action) => ({
    label: LABELS[action],
    onClick: () => {
      const run = handlers.get(action);
      if (run) run();
      else log.warn(`No handler is registered for toast action ${action}`);
    },
  }));
}
