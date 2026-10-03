// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Object3D } from "three";

/**
 * Makes exactly the outline-only proxies inside the current outline selections visible.
 *
 * Proxies (per-cell, per-pixel and per-lens meshes flagged `visualizerOutlineOnly`) stay hidden so
 * they cost nothing in render-list construction, and are revealed only while an outline pass
 * targets them. The selection arrays are mutated in place by the selection manager, so callers
 * run this before every outline render; it allocates nothing and only walks selected subtrees.
 */
export function syncOutlineProxyVisibility(
  selections: readonly (readonly Object3D[])[],
  visible: Set<Object3D>,
): void {
  for (const object of visible) object.visible = false;
  visible.clear();
  for (const selected of selections)
    for (const object of selected) revealOutlineProxies(object, visible);
}

/** Reveals and records every outline-only proxy in an object's subtree, the object included. */
function revealOutlineProxies(object: Object3D, visible: Set<Object3D>): void {
  if (object.userData.visualizerOutlineOnly === true) {
    object.visible = true;
    visible.add(object);
  }
  const children = object.children;
  for (let i = 0; i < children.length; i++)
    revealOutlineProxies(children[i], visible);
}
