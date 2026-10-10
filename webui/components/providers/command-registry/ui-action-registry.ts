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

/** A UI action as remembered for binding, without the handler of any one mount. */
export type UiActionDescriptor = Pick<
  UiAction,
  "id" | "name" | "description" | "category" | "icon"
>;

/** Result of running a UI action by ID. */
export type UiActionOutcome =
  /** The action ran. */
  | "succeeded"
  /** No mounted component currently provides the action, such as a closed panel's. */
  | "unavailable"
  /** The action's handler threw. */
  | "failed";

/** Actions that can run now: the newest mounted registration of each ID. */
export const $uiActions = atom<UiAction[]>([]);

/**
 * Every UI action registered during this session, whether or not it can run now.
 *
 * Bindings may target actions of panels that are currently closed, so pickers list these
 * rather than only the mounted actions.
 */
export const $uiActionCatalog = atom<UiActionDescriptor[]>([]);

/** Mounted registrations per action ID, oldest first; the last one handles invocations. */
const registrations = new Map<string, UiAction[]>();

/** Returns the namespaced ID other surfaces use to bind and invoke a UI action. */
export function uiActionId(action: Pick<UiAction, "id">): string {
  return `${UI_ACTION_PREFIX}${action.id}`;
}

/** Publishes the newest registration of every action ID that has one. */
function publishAvailableActions(): void {
  $uiActions.set(
    [...registrations.values()].flatMap((stack) => stack.slice(-1)),
  );
}

/** Adds or refreshes an action's catalog entry, keeping its first-seen position. */
function rememberAction(action: UiAction): void {
  const descriptor: UiActionDescriptor = {
    id: action.id,
    name: action.name,
    description: action.description,
    category: action.category,
    icon: action.icon,
  };
  const catalog = $uiActionCatalog.get();
  $uiActionCatalog.set(
    catalog.some((existing) => existing.id === action.id)
      ? catalog.map((existing) =>
          existing.id === action.id ? descriptor : existing,
        )
      : [...catalog, descriptor],
  );
}

/**
 * Registers a UI action and returns the disposer its owner calls on cleanup.
 *
 * Several mounts may register the same ID, such as two open timeline panels; the newest
 * handles invocations, and disposing one registration never removes another's.
 */
export function registerUiAction(action: UiAction): () => void {
  const registered: UiAction = {
    ...action,
    category: action.category || DEFAULT_CATEGORY,
  };
  const stack = registrations.get(action.id) ?? [];
  registrations.set(action.id, [...stack, registered]);
  rememberAction(registered);
  publishAvailableActions();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const remaining = (registrations.get(action.id) ?? []).filter(
      (candidate) => candidate !== registered,
    );
    if (remaining.length > 0) {
      registrations.set(action.id, remaining);
    } else {
      registrations.delete(action.id);
    }
    publishAvailableActions();
  };
}

/** Returns the remembered descriptor of a namespaced `ui.*` action ID, if it is known. */
export function describeUiAction(id: string): UiActionDescriptor | undefined {
  return $uiActionCatalog
    .get()
    .find((descriptor) => uiActionId(descriptor) === id);
}

/**
 * Executes a UI action by its namespaced `ui.*` ID.
 *
 * Reports `unavailable` when no mounted component provides the action, so surfaces bound to
 * it can tell the operator instead of silently doing nothing.
 */
export function executeUiAction(
  id: string,
  context: UiActionExecutionContext,
): UiActionOutcome {
  if (!id.startsWith(UI_ACTION_PREFIX)) return "unavailable";
  const stack = registrations.get(id.slice(UI_ACTION_PREFIX.length)) ?? [];
  const action = stack[stack.length - 1];
  if (!action) {
    log.debug("UI action is not available in this client", { id });
    return "unavailable";
  }
  try {
    action.execute(context);
    return "succeeded";
  } catch (error) {
    log.error("UI action failed", { id, error });
    return "failed";
  }
}
