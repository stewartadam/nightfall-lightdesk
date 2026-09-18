// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { setStoreAction } from "../lib/nanostore-action";
import type * as types from "../types";
import {
  fixtureLibrary,
  fixtureProfile,
  objectLibrary,
  objectProfile,
} from "./appStores";

/** Applies the backend fixture-library listing to the fixture library store. */
export function applyAvailableFixturesResponse(
  fixtures: types.AvailableFixtureInfo[],
): void {
  setStoreAction(
    fixtureLibrary,
    "Receive ListAvailableFixturesResponse",
    fixtures,
  );
}

/** Applies the backend fixture profile response to the preview profile store. */
export function applyFixtureProfileResponse(
  profile: types.GetFixtureProfileResponse,
): void {
  setStoreAction(fixtureProfile, "Receive GetFixtureProfileResponse", profile);
}

/** Applies the backend object-library listing to the object library store. */
export function applyAvailableObjectsResponse(
  objects: types.AvailableObjectInfo[],
): void {
  setStoreAction(
    objectLibrary,
    "Receive ListAvailableObjectsResponse",
    objects,
  );
}

/** Applies the backend object profile response to the preview profile store. */
export function applyObjectProfileResponse(
  profile: types.GetObjectProfileResponse,
): void {
  setStoreAction(objectProfile, "Receive GetObjectProfileResponse", profile);
}
