// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";

import { useWorkspaceActivity } from "./workspace-activity";

export interface PanelLivenessRegistration {
  /** Dockview panel ID whose backing data is being tracked. */
  panelId: string;
  /** Returns whether the panel still has valid backing data. */
  isAlive: () => boolean;
  /** Whether the shell should close the panel when isAlive returns false. */
  closeWhenDead?: boolean;
}

export interface PanelLivenessEntry
  extends Omit<PanelLivenessRegistration, "isAlive"> {
  /** Stable registration ID used to unregister one mounted panel instance. */
  registrationId: number;
  workspaceActive: Accessor<boolean>;
  /** Returns the latest panel-owned liveness state. */
  isAlive: Accessor<boolean>;
}

const [panelLivenessEntries, setPanelLivenessEntries] = createSignal<
  PanelLivenessEntry[]
>([]);
let nextPanelLivenessRegistrationId = 0;

/** Returns the currently mounted panel liveness registrations. */
export function getPanelLivenessEntries(): readonly PanelLivenessEntry[] {
  return panelLivenessEntries();
}

/** Adds a panel liveness entry and returns an unregister callback. */
function addPanelLivenessEntry(entry: PanelLivenessEntry): () => void {
  setPanelLivenessEntries((current) => [...current, entry]);

  return () => {
    setPanelLivenessEntries((current) =>
      current.filter(
        (candidate) => candidate.registrationId !== entry.registrationId,
      ),
    );
  };
}

/** Registers a panel liveness predicate for the current Solid owner lifetime. */
export function registerPanelLiveness(
  registration: PanelLivenessRegistration,
): () => void {
  const registrationId = nextPanelLivenessRegistrationId++;
  const [isAlive, setIsAlive] = createSignal(registration.isAlive());
  const entry = {
    panelId: registration.panelId,
    closeWhenDead: registration.closeWhenDead,
    registrationId,
    workspaceActive: useWorkspaceActivity(),
    isAlive,
  } satisfies PanelLivenessEntry;
  const unregister = addPanelLivenessEntry(entry);

  /** Publishes panel-owned liveness without making DockApp track panel internals. */
  createEffect(() => {
    setIsAlive(registration.isAlive());
  });

  return unregister;
}

/** Registers panel liveness for the current Solid owner lifetime. */
export function usePanelLiveness(
  registration: PanelLivenessRegistration,
): void {
  const unregister = registerPanelLiveness(registration);
  onCleanup(unregister);
}
