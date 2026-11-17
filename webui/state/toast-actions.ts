// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getLogger } from "../lib/logger";
import type { ToastAction } from "../lib/notification-queue";
import type { ToastAction as EngineToastAction } from "../types";

const log = getLogger(import.meta.url);

type EngineToastActionType = EngineToastAction["type"];

/** The engine action of one kind, with the payload that kind carries. */
type EngineToastActionOf<Type extends EngineToastActionType> = Extract<
  EngineToastAction,
  { type: Type }
>;

/** Button text for each follow-up the engine can attach to a toast. */
const LABELS: {
  [Type in EngineToastActionType]: (
    action: EngineToastActionOf<Type>,
  ) => string;
} = {
  OpenNetworkSettings: () => "Open network settings",
  OpenExternalControlSettings: () => "Open external control settings",
  OpenUsbDmxOutputs: () => "Open I/O Transports",
  UpdateUsbDmxPort: () => "Update port",
  ChooseUsbDmxOutput: (action) => `Use as ${action.data.target}`,
};

const handlers = new Map<
  EngineToastActionType,
  (action: EngineToastAction) => void
>();

/**
 * Lets the shell decide what an engine toast action opens or does. The engine only names the
 * follow-up and its payload, and the shell owns the dialogs, panels and command client, so
 * websocket handlers never import UI modules. Returns a function that removes the registration.
 */
export function registerToastActionHandler<Type extends EngineToastActionType>(
  type: Type,
  run: (action: EngineToastActionOf<Type>) => void,
): () => void {
  const handler = run as (action: EngineToastAction) => void;
  handlers.set(type, handler);
  return () => {
    if (handlers.get(type) === handler) handlers.delete(type);
  };
}

/** Returns the button text for one engine toast action. */
function actionLabel(action: EngineToastAction): string {
  const label = LABELS[action.type] as (action: EngineToastAction) => string;
  return label(action);
}

/**
 * Turns the actions the engine attached to a toast into buttons. Each button looks up its handler
 * when clicked, so toasts replayed before the shell finished mounting still work.
 */
export function toastActionButtons(
  actions: readonly EngineToastAction[] | undefined,
): ToastAction[] {
  return (actions ?? []).map((action) => ({
    label: actionLabel(action),
    onClick: () => {
      const run = handlers.get(action.type);
      if (run) run(action);
      else log.warn(`No handler is registered for toast action ${action.type}`);
    },
  }));
}
