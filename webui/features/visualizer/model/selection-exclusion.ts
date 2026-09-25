// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Marks for scene objects that must never contribute to a fixture's
 * whole-fixture selection outline (beams, lenses, emitters, overlays).
 */

import type { Object3D } from "three";

const EXCLUDE_FROM_SELECTION_KEY = "excludeFromSelection";

/**
 * Flag an object so whole-fixture selection outlines skip it.
 * Element-level targeting may still return the object explicitly.
 */
export function excludeFromSelection<T extends Object3D>(object: T): T {
  object.userData[EXCLUDE_FROM_SELECTION_KEY] = true;
  return object;
}

/** Return whether an object was flagged via {@link excludeFromSelection}. */
export function isExcludedFromSelection(object: Object3D): boolean {
  return object.userData[EXCLUDE_FROM_SELECTION_KEY] === true;
}
