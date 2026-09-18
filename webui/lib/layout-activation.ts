// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";
import {
  activeLayoutId,
  busyLayoutIds,
  getLayoutSession,
  rememberLayoutSession,
} from "../state/layout-switcher";
import {
  createSerializedLayout,
  restoreSerializedLayout,
} from "./dockview-layout";
import { commitActiveLayout, getStoredLayout } from "./layoutStorage";
import { getLogger } from "./logger";

type LayoutActivator = (
  api: DockviewApi,
  layoutId: string,
  options: { reset?: boolean; adoptCurrent?: boolean },
) => Promise<boolean>;
let workspaceActivator: LayoutActivator | undefined;

/** Installs the live workspace owner while keeping standalone restoration available. */
export function registerLayoutActivator(activate: LayoutActivator): () => void {
  workspaceActivator = activate;
  return () => {
    if (workspaceActivator === activate) workspaceActivator = undefined;
  };
}

const log = getLogger(import.meta.url);

/**
 * Recalls a saved layout or its working copy, preserving the outgoing arrangement.
 * Can adopt the mounted arrangement as a named layout without restoring panels.
 * Commits selection only after restoration succeeds and rolls back a failed restore.
 */
export function activateStoredLayout(
  api: DockviewApi,
  layoutId: string,
  options: { reset?: boolean; adoptCurrent?: boolean } = {},
): boolean | Promise<boolean> {
  const saved = getStoredLayout(layoutId);
  if (!saved || busyLayoutIds.get().includes(layoutId)) return false;
  if (!saved.shownInSwitcher) return false;
  if (layoutId === activeLayoutId.get() && !options.reset) return true;

  if (workspaceActivator) return workspaceActivator(api, layoutId, options);

  const previousId = activeLayoutId.get();
  let previous: ReturnType<typeof createSerializedLayout> | undefined;
  try {
    previous = createSerializedLayout(api);
    const target = options.adoptCurrent
      ? previous
      : !options.reset
        ? (getLayoutSession(layoutId) ?? saved)
        : saved;
    if (!options.adoptCurrent) restoreSerializedLayout(api, target);
    if (!commitActiveLayout(layoutId, target))
      throw new Error("Could not persist active layout");
    if (previousId) rememberLayoutSession(previousId, previous);
    rememberLayoutSession(
      layoutId,
      createSerializedLayout(api),
      !options.adoptCurrent && (options.reset || !getLayoutSession(layoutId))
        ? saved
        : undefined,
    );
    activeLayoutId.set(layoutId);
    return true;
  } catch (error) {
    log.error("Could not activate layout", error);
    if (previous && !options.adoptCurrent) {
      try {
        restoreSerializedLayout(api, previous);
      } catch (rollbackError) {
        log.error("Could not restore previous arrangement", rollbackError);
      }
    }
    return false;
  }
}
