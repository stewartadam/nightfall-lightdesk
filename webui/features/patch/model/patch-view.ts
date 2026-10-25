// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import { bestEffortPersistentAtom } from "../../../lib/best-effort-persistent-atom";

export type PatchTab = "fixtures" | "routes";

const PATCH_PANEL_ACTIVE_TAB_STORAGE_KEY = "nightfall-patch-panel:active-tab";

/**
 * Returns whether a stored value is a supported patch panel tab.
 */
export function isPatchTab(value: string): value is PatchTab {
  return value === "fixtures" || value === "routes";
}

/** Remembers whether Patch shows its Fixtures or DMX Routes view across sessions. */
export const patchPanelActiveTab = bestEffortPersistentAtom<PatchTab>(
  PATCH_PANEL_ACTIVE_TAB_STORAGE_KEY,
  "fixtures",
  {
    decode: (value) => (isPatchTab(value) ? value : "fixtures"),
    encode: (value) => value,
  },
);

/** A one-shot request for the Fixtures view to scroll to fixtures and optionally select them. */
export interface PatchFixtureRevealRequest {
  fixtureIds: readonly number[];
  /** Replaces the view's row selection with the fixtures as well as scrolling to them. */
  select: boolean;
  /** Column key to scroll into view horizontally; the ID column when absent. */
  column?: string;
  requestId: number;
  /** `performance.now()` when requested, so a reveal can expire. */
  requestedAt: number;
}

/**
 * How long a reveal applies after it was requested: to fixtures still arriving, and to Fixtures
 * views that mount meanwhile, such as one shown by the same click. Later on it is ignored, so a
 * reveal never fires long after the fact.
 */
export const PATCH_FIXTURE_REVEAL_WINDOW_MS = 3000;

/** Latest reveal for Fixtures views; each mounted view acts on a given request once. */
export const patchFixtureRevealRequest = atom<PatchFixtureRevealRequest | null>(
  null,
);

let nextRevealRequestId = 0;

/**
 * Asks mounted Fixtures views to scroll fixtures into view, and to select them unless `select` is
 * false, for example fixtures the Add fixture wizard just created. Each view waits until every
 * fixture has arrived.
 */
export function revealPatchFixtures(
  fixtureIds: readonly number[],
  { select = true, column }: { select?: boolean; column?: string } = {},
): void {
  nextRevealRequestId += 1;
  patchFixtureRevealRequest.set({
    fixtureIds,
    select,
    column,
    requestId: nextRevealRequestId,
    requestedAt: performance.now(),
  });
}
