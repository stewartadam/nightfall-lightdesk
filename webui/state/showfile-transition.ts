// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";

/** Store generations captured when the backend began replacing the showfile world. */
export type ShowfileTransition = {
  /** Resync generation seen before the replacement world's resync. */
  resyncGeneration: number;
  /** Confirmed showfile revision seen before the replacement world reported its show. */
  showfileRevision: number;
};

/** Frontend state that must catch up before a replaced showfile world is revealed. */
export type ShowfileTransitionProgress = {
  resyncComplete: boolean;
  resyncGeneration: number;
  showfileRevision: number;
  layoutShowfileRevision: number;
};

/** Pending showfile replacement whose dock stays hidden until panels settle, or null. */
export const showfileTransition = atom<ShowfileTransition | null>(null);

/** Hides the dock until the replacement world's state and layout have loaded. */
export function beginShowfileTransition(transition: ShowfileTransition): void {
  if (showfileTransition.get()) return;
  showfileTransition.set(transition);
}

/** Reveals the dock after a showfile replacement settles or is abandoned. */
export function endShowfileTransition(): void {
  showfileTransition.set(null);
}

/**
 * Returns whether the replacement world's data has arrived and Dockview has
 * restored the layout for the newly confirmed showfile.
 */
export function showfileTransitionDataReady(
  transition: ShowfileTransition,
  progress: ShowfileTransitionProgress,
): boolean {
  return (
    progress.resyncComplete &&
    progress.resyncGeneration > transition.resyncGeneration &&
    progress.showfileRevision > transition.showfileRevision &&
    progress.layoutShowfileRevision === progress.showfileRevision
  );
}
