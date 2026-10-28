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
 *
 * The same walk fills `hiddenFill[i]` (when given) with 1 if selection `i` may show the occluded
 * fill and 0 otherwise. A selection needs a mesh or sprite, because OutlineNode skips its mask
 * pass without one and leaves the previous frame's mask behind. A selection that targets a proxy
 * directly is excluded too: the proxy shares its exact depth with the unselected batch or cell
 * mesh drawn at the same transform, so OutlineNode reports the whole cell as hidden.
 */
export function syncOutlineProxyVisibility(
  selections: readonly (readonly Object3D[])[],
  visible: Set<Object3D>,
  hiddenFill?: number[],
): void {
  for (const object of visible) object.visible = false;
  visible.clear();
  for (let i = 0; i < selections.length; i++) {
    let drawable = false;
    let targetsProxy = false;
    for (const object of selections[i]) {
      if (object.userData.visualizerOutlineOnly === true) targetsProxy = true;
      if (revealOutlineProxies(object, visible)) drawable = true;
    }
    if (hiddenFill) hiddenFill[i] = drawable && !targetsProxy ? 1 : 0;
  }
}

/**
 * Reveals and records every outline-only proxy in an object's subtree, the object included, and
 * reports whether the subtree holds any mesh or sprite OutlineNode would draw into its mask.
 */
function revealOutlineProxies(
  object: Object3D,
  visible: Set<Object3D>,
): boolean {
  if (object.userData.visualizerOutlineOnly === true) {
    object.visible = true;
    visible.add(object);
  }
  const target = object as { isMesh?: boolean; isSprite?: boolean };
  let drawable = target.isMesh === true || target.isSprite === true;
  const children = object.children;
  for (let i = 0; i < children.length; i++)
    if (revealOutlineProxies(children[i], visible)) drawable = true;
  return drawable;
}
