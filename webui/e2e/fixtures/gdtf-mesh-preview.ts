// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  type Group,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";

/** Render and measure two decoded revisions using a deterministic resource preview, independent of stage simulation. */
export function renderMeshRevisionPreview(original: Group, updated: Group) {
  const firstWidth = new Box3()
    .setFromObject(original)
    .getSize(new Vector3()).x;
  const secondWidth = new Box3()
    .setFromObject(updated)
    .getSize(new Vector3()).x;
  const scene = new Scene();
  scene.background = new Color(0x101820);
  scene.add(new AmbientLight(0xffffff, 2));
  const light = new DirectionalLight(0xffffff, 5);
  light.position.set(0, 0, 5);
  scene.add(light);
  original.position.x = -1;
  updated.position.x = 1;
  scene.add(original, updated);
  const camera = new OrthographicCamera(-3, 3, 1.5, -1.5, 0.1, 10);
  camera.position.set(1, 0.5, 5);
  camera.lookAt(1, 0.5, 0);
  const renderer = new WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(800, 400);
  document.body.append(renderer.domElement);
  renderer.render(scene, camera);
  return { firstWidth, secondWidth, renderer };
}
