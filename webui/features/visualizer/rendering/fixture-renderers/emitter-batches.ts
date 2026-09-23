// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Group,
  InstancedMesh,
  type Mesh,
  MeshBasicMaterial,
} from "three/webgpu";

export interface EmitterBatch {
  mesh: InstancedMesh;
  sources: Mesh[];
}

/** Batches identical cells sharing a rigid parent while retaining individual selection proxies. */
export function createEmitterBatches(
  parent: Group,
  sets: Mesh[][],
): EmitterBatch[] {
  return sets
    .filter((sources) => sources.length > 0)
    .map((sources) => {
      const material = new MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
      });
      const mesh = new InstancedMesh(
        sources[0].geometry,
        material,
        sources.length,
      );
      mesh.name = `${sources[0].name}Instances`;
      mesh.userData.visualizerCellBatch = true;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        source.updateMatrix();
        mesh.setMatrixAt(i, source.matrix);
        mesh.setColorAt(i, (source.material as MeshBasicMaterial).color);
        source.userData.visualizerOutlineOnly = true;
        source.visible = false;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      parent.add(mesh);
      return { mesh, sources };
    });
}

/** Copies independent emitter colors into shared GPU buffers without changing their selection proxies. */
export function updateEmitterBatches(data: {
  emitterBatches: EmitterBatch[];
}): void {
  for (const { mesh, sources } of data.emitterBatches) {
    for (let i = 0; i < sources.length; i++) {
      mesh.setColorAt(i, (sources[i].material as MeshBasicMaterial).color);
    }
    mesh.instanceColor!.needsUpdate = true;
  }
}
