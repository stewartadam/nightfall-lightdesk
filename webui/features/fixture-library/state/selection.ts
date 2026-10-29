// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Fixture Library state management using nanostores.
 * Tracks the selected library row for properties panel display.
 */

import { atom } from "nanostores";
import { setStoreAction } from "../../../lib/nanostore-action";
import { unproxify } from "../../../lib/utils";
import type * as types from "../../../types";

/** One Fixture Library row: a loaded profile, or a definition file that failed to load. */
export type FixtureLibraryRow =
  | { kind: "fixture"; fixture: types.AvailableFixtureInfo }
  | { kind: "unloadable"; file: types.UnloadableFixtureFile };

export const fixtureLibrarySelection = atom<FixtureLibraryRow | null>(null);

/**
 * Selects a Fixture Library row for the properties panel, or clears the selection when
 * `row` is null.
 */
export function setFixtureLibrarySelection(
  row: FixtureLibraryRow | null,
): void {
  // If we retain proxied objects in the store, it can lead to corruption of the
  // prior stored memos in some cases.
  setStoreAction(
    fixtureLibrarySelection,
    "Set Fixture Library Selection",
    row ? unproxify(row) : null,
  );
}

/** Selects a loaded library profile for the properties panel. */
export function setFixtureLibrarySelectedFixture(
  fixture: types.AvailableFixtureInfo,
): void {
  setFixtureLibrarySelection({ kind: "fixture", fixture });
}
