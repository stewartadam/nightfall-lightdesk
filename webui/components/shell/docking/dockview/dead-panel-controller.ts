// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";
import { type Accessor, createEffect, onCleanup } from "solid-js";
import { getLogger } from "../../../../lib/logger";
import {
  getPanelLivenessEntries,
  type PanelLivenessEntry,
} from "../../../../lib/panel-liveness";

const log = getLogger(import.meta.url);

const PANEL_LIVENESS_CLOSE_DELAY_MS = 0;

interface DeadPanelControllerOptions {
  /** The workspace's published Dockview API, or null before publish and after unmount. */
  api: Accessor<DockviewApi | null>;
  /** Workspace activity accessor identifying the liveness registrations this workspace owns. */
  workspaceActive: Accessor<boolean>;
}

/** Returns whether a liveness registration currently requests panel closure. */
function shouldCloseDeadPanel(entry: PanelLivenessEntry): boolean {
  return entry.closeWhenDead !== false && !entry.isAlive();
}

/**
 * Closes this workspace's panels whose liveness predicates report them dead.
 * Close requests are batched onto a timer so panels are never closed inside
 * the reactive update that observed them dying, and a panel that recovers
 * before the timer fires stays open. Must be called inside the owning
 * component so the watcher and pending timer share its lifetime.
 */
export function createDeadPanelController(options: DeadPanelControllerOptions) {
  const pendingClosePanelIds = new Set<string>();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Closes panels that remain dead after the liveness close delay. */
  const closePendingDeadPanels = () => {
    closeTimer = undefined;
    const dockApi = options.api();
    if (!dockApi) {
      pendingClosePanelIds.clear();
      return;
    }

    const deadPanelIds = new Set(
      getPanelLivenessEntries()
        .filter(
          (entry) =>
            entry.workspaceActive === options.workspaceActive &&
            pendingClosePanelIds.has(entry.panelId),
        )
        .filter(shouldCloseDeadPanel)
        .map((entry) => entry.panelId),
    );
    pendingClosePanelIds.clear();

    for (const panelId of deadPanelIds) {
      try {
        dockApi.getPanel(panelId)?.api.close();
      } catch (error) {
        log.warn("Ignoring stale liveness panel close request", error);
      }
    }
  };

  /** Schedules a panel close pass outside the current reactive update. */
  const scheduleDeadPanelClose = (panelId: string) => {
    pendingClosePanelIds.add(panelId);
    if (closeTimer !== undefined) return;
    closeTimer = setTimeout(
      closePendingDeadPanels,
      PANEL_LIVENESS_CLOSE_DELAY_MS,
    );
  };

  /** Watches mounted panel liveness predicates and delegates stale closes. */
  createEffect(() => {
    if (!options.api()) return;

    for (const entry of getPanelLivenessEntries()) {
      if (
        entry.workspaceActive === options.workspaceActive &&
        shouldCloseDeadPanel(entry)
      ) {
        scheduleDeadPanelClose(entry.panelId);
      }
    }
  });

  /** Cancels shell-owned panel liveness work when the workspace unmounts. */
  onCleanup(() => {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
    }
    pendingClosePanelIds.clear();
  });
}
