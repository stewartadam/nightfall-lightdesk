// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three/webgpu";
import { createEmitterBatches, updateEmitterBatches } from "./emitter-batches";

/** Static cell colors must not re-upload the shared instance buffer every frame. */
test("emitter batches upload instance colors only when a cell changes", () => {
  const geometry = new BoxGeometry();
  const sources = Array.from(
    { length: 3 },
    () => new Mesh(geometry, new MeshBasicMaterial({ color: 0x336699 })),
  );
  const data = { emitterBatches: createEmitterBatches(new Group(), [sources]) };
  const colors = data.emitterBatches[0].mesh.instanceColor!;
  const version = colors.version;
  updateEmitterBatches(data);
  updateEmitterBatches(data);
  assert.equal(colors.version, version);
  (sources[1].material as MeshBasicMaterial).color.setRGB(0.2, 0.4, 0.6);
  updateEmitterBatches(data);
  assert.equal(colors.version, version + 1);
  assert.deepEqual(
    Array.from(colors.array.slice(3, 6)),
    [0.2, 0.4, 0.6].map(Math.fround),
  );
  updateEmitterBatches(data);
  assert.equal(colors.version, version + 1);
  geometry.dispose();
});
