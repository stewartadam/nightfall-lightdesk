// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { outline } from "three/addons/tsl/display/OutlineNode.js";
import { PerspectiveCamera, Scene } from "three/webgpu";
import { outlineMaskTexture } from "./outline-hidden-fill";

/**
 * The hidden fill reads OutlineNode's private mask texture and silently drops the fill without
 * it, so a three upgrade that renames the field must fail here instead.
 */
test("hidden fill finds the installed OutlineNode's mask texture", () => {
  const node = outline(new Scene(), new PerspectiveCamera());
  assert.ok(outlineMaskTexture(node));
  node.dispose();
});
