// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createEffect, onCleanup } from "solid-js";
import { useWorkspaceActivity } from "./workspace-activity";

/** Transient activity that can replace a panel's registered tab icon. */
export type PanelTabStatus = "saving";

export interface PanelTabStatusRegistration {
  /** Publishes the current transient status for this mounted panel owner. */
  setStatus: (status: PanelTabStatus | undefined) => void;
  /** Removes this owner without disturbing newer registrations for the panel. */
  dispose: () => void;
}

type PanelTabStatusListener = (status: PanelTabStatus | undefined) => void;

interface PanelTabStatusEntry {
  panelId: string;
  status: PanelTabStatus;
}

const entries = new Map<number, PanelTabStatusEntry>();
const listeners = new Map<string, Set<PanelTabStatusListener>>();
let nextRegistrationId = 0;

/** Returns the effective transient status published for one panel. */
export function getPanelTabStatus(panelId: string): PanelTabStatus | undefined {
  for (const entry of entries.values()) {
    if (entry.panelId === panelId && entry.status === "saving") return "saving";
  }
  return undefined;
}

/** Notifies tab renderers after a panel owner's status changes. */
function notifyPanelTabStatus(panelId: string): void {
  const status = getPanelTabStatus(panelId);
  for (const listener of listeners.get(panelId) ?? []) listener(status);
}

/** Subscribes an imperative tab renderer and immediately supplies current state. */
export function subscribePanelTabStatus(
  panelId: string,
  listener: PanelTabStatusListener,
): () => void {
  const panelListeners = listeners.get(panelId) ?? new Set();
  panelListeners.add(listener);
  listeners.set(panelId, panelListeners);
  listener(getPanelTabStatus(panelId));

  return () => {
    panelListeners.delete(listener);
    if (panelListeners.size === 0) listeners.delete(panelId);
  };
}

/** Creates one independently disposable publisher for a mounted panel owner. */
export function registerPanelTabStatus(
  panelId: string,
): PanelTabStatusRegistration {
  const registrationId = nextRegistrationId++;
  let currentStatus: PanelTabStatus | undefined;
  let disposed = false;

  return {
    setStatus(status) {
      if (disposed || status === currentStatus) return;
      currentStatus = status;
      if (status) entries.set(registrationId, { panelId, status });
      else entries.delete(registrationId);
      notifyPanelTabStatus(panelId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const hadStatus = entries.delete(registrationId);
      currentStatus = undefined;
      if (hadStatus) notifyPanelTabStatus(panelId);
    },
  };
}

/** Publishes reactive panel status for the lifetime of the current Solid owner. */
export function usePanelTabStatus(
  panelId: string,
  status: Accessor<PanelTabStatus | undefined>,
): void {
  const workspaceActive = useWorkspaceActivity();
  const registration = registerPanelTabStatus(panelId);

  /** Mirrors panel-owned reactive state into the imperative Dockview tab shell. */
  createEffect(() =>
    registration.setStatus(workspaceActive() ? status() : undefined),
  );
  onCleanup(registration.dispose);
}
