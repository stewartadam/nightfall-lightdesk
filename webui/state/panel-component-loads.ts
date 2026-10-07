// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";

/** Number of panel component modules still loading for mounted panels. */
export const pendingPanelComponentLoads = atom(0);

/**
 * Wraps a panel component loader so its in-flight import is counted until it
 * settles, letting the showfile veil wait for panel code that is still arriving
 * on a cold start.
 */
export function trackPanelComponentLoad<T>(
  load: () => Promise<T>,
): () => Promise<T> {
  return () => {
    pendingPanelComponentLoads.set(pendingPanelComponentLoads.get() + 1);
    return load().finally(() => {
      pendingPanelComponentLoads.set(pendingPanelComponentLoads.get() - 1);
    });
  };
}
