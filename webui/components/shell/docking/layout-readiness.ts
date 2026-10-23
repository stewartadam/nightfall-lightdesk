// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";

/** Showfile revision whose Dockview layout has finished restoring. */
export const dockviewLayoutShowfileRevision = atom<number>(-1);
/** Settings snapshot revision represented by the restored Dockview layout. */
export const dockviewLayoutSettingsSnapshotRevision = atom<number>(0);
/**
 * Whether the restored Dockview kept this device's own arrangement for the showfile,
 * rather than starting from the showfile's default layout.
 */
export const dockviewLayoutKeptDeviceArrangement = atom<boolean>(false);

/** Records that Dockview applied the layout for a showfile revision. */
export function markDockviewLayoutReady(
  showfileRevision: number,
  settingsSnapshotRevision: number,
  keptDeviceArrangement: boolean,
): void {
  queueMicrotask(() => {
    // Set before the revisions, whose subscribers read it when they react.
    dockviewLayoutKeptDeviceArrangement.set(keptDeviceArrangement);
    dockviewLayoutShowfileRevision.set(showfileRevision);
    dockviewLayoutSettingsSnapshotRevision.set(settingsSnapshotRevision);
  });
}
