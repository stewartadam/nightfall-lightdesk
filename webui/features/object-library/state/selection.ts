// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import { setStoreAction } from "../../../lib/nanostore-action";
import { unproxify } from "../../../lib/utils";
import type { AvailableObjectInfo } from "../../../types";

/**
 * Currently selected object in the object library panel.
 * Used by the properties panel to show detailed info.
 */
export const objectLibrarySelectedObject = atom<AvailableObjectInfo | null>(
  null,
);

export const setObjectLibrarySelectedObject = (
  object: AvailableObjectInfo | null,
) => {
  // Avoid retaining proxied row objects; can corrupt previous row state.
  setStoreAction(
    objectLibrarySelectedObject,
    "Set Object Library Selection",
    object ? unproxify(object) : null,
  );
};
