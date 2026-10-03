// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export { bloom } from "three/addons/tsl/display/BloomNode.js";
export {
  float,
  ivec2,
  pass,
  positionWorld,
  renderOutput,
  screenUV,
  texture,
  textureLoad,
  uniform,
  vec2,
  vec4,
} from "three/tsl";
// Browser shader fixtures must share Vite's Three module instance with application materials.
export * from "three/webgpu";
