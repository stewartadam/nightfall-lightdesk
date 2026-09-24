// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import { getLogger } from "../../../lib/logger";
import {
  DEFAULT_CATEGORY,
  type UiAction,
  type UiActionExecutionContext,
} from "./command-types";

const log = getLogger(import.meta.url);

/** ID prefix reserved for actions hosted by the Web UI rather than the backend. */
export const UI_ACTION_PREFIX = "ui.";

/** Actions currently registered by mounted UI components. */
export const $uiActions = atom<UiAction[]>([]);

/** Returns the namespaced ID other surfaces use to bind and invoke a UI action. */
export function uiActionId(action: Pick<UiAction, "id">): string {
  return `${UI_ACTION_PREFIX}${action.id}`;
}

/** Registers a UI action and returns the unsubscriber its owner calls on cleanup. */
export function registerUiAction(action: UiAction): () => void {
  const registered = {
    ...action,
    category: action.category || DEFAULT_CATEGORY,
  };
  $uiActions.set([
    ...$uiActions.get().filter((existing) => existing.id !== action.id),
    registered,
  ]);
  return () => unregisterUiAction(action.id);
}

/** Removes a UI action by its local ID. */
export function unregisterUiAction(id: string): void {
  $uiActions.set($uiActions.get().filter((action) => action.id !== id));
}

/**
 * Executes a UI action by its namespaced `ui.*` ID.
 *
 * Returns whether an action with that ID is currently registered in this client.
 */
export function executeUiAction(
  id: string,
  context: UiActionExecutionContext,
): boolean {
  if (!id.startsWith(UI_ACTION_PREFIX)) return false;
  const localId = id.slice(UI_ACTION_PREFIX.length);
  const action = $uiActions.get().find((candidate) => candidate.id === localId);
  if (!action) {
    log.debug("UI action is not registered in this client", { id });
    return false;
  }
  action.execute(context);
  return true;
}
