// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type OutlineNode from "three/addons/tsl/display/OutlineNode.js";
import { float, screenUV } from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";
import { getLogger } from "../../../../lib/logger";

const log = getLogger(import.meta.url);

/**
 * Returns the private mask texture OutlineNode renders its selection into, or undefined when the
 * installed three release no longer has it.
 */
export function outlineMaskTexture(
  outlineNode: OutlineNode,
): TextureNode | undefined {
  const mask = (outlineNode as unknown as { _maskTextureUniform?: TextureNode })
    ._maskTextureUniform;
  return mask?.isTextureNode ? mask : undefined;
}

/**
 * Returns a screen-space mask that is 1 where an outline pass's selected objects are hidden
 * behind unselected geometry and 0 elsewhere.
 *
 * OutlineNode already renders this information into its full-resolution mask target (red is 0
 * on selected pixels, green is 1 where those pixels fail the depth test against the rest of the
 * scene), but only exposes the derived edges. Sampling the mask directly lets the visualizer
 * fill occluded selections without a second selection render. The texture is private to
 * three's implementation, so a release that renames it degrades to no fill (with a warning)
 * rather than breaking the pipeline; a node test catches that on upgrade.
 */
export function outlineHiddenMask(outlineNode: OutlineNode): Node<"float"> {
  const mask = outlineMaskTexture(outlineNode);
  if (!mask) {
    log.warn(
      "OutlineNode mask texture not found; occluded selections are drawn without a fill",
    );
    return float(0);
  }
  const sample = mask.sample(screenUV);
  return float(1).sub(sample.r).mul(sample.g);
}
