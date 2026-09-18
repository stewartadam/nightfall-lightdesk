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
/** Active-layout key represented by the restored Dockview layout. */
export const dockviewLayoutActiveLayoutKey = atom<string | null>(null);

/** Records that Dockview applied the layout for a showfile revision. */
export function markDockviewLayoutReady(
  showfileRevision: number,
  settingsSnapshotRevision: number,
  activeLayoutKey: string | null,
): void {
  queueMicrotask(() => {
    dockviewLayoutShowfileRevision.set(showfileRevision);
    dockviewLayoutSettingsSnapshotRevision.set(settingsSnapshotRevision);
    dockviewLayoutActiveLayoutKey.set(activeLayoutKey);
  });
}
