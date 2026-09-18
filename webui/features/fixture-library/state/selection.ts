// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Fixture Library state management using nanostores.
 * Tracks selected fixture for properties panel display.
 */

import { atom } from "nanostores";
import { setStoreAction } from "../../../lib/nanostore-action";
import { unproxify } from "../../../lib/utils";
import type * as types from "../../../types";

export const fixtureLibrarySelectedFixture =
  atom<types.AvailableFixtureInfo | null>(null);

export function setFixtureLibrarySelectedFixture(
  fixture: types.AvailableFixtureInfo | null,
): void {
  // If we retain proxied objects in the store, it can lead to corruption of the
  // prior stored memos in some cases.
  setStoreAction(
    fixtureLibrarySelectedFixture,
    "Set Fixture Library Selection",
    fixture ? unproxify(fixture) : null,
  );
}
