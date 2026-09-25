// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Camera,
  type Color,
  Frustum,
  Matrix4,
  type PointLight,
  Sphere,
  Vector3,
} from "three/webgpu";

/** Selects a bounded set of surface sources with reusable heap storage and stable tie-breaking. */
export class SurfaceLightBudget {
  private readonly scores: Float64Array;
  private readonly frustum = new Frustum();
  private readonly projection = new Matrix4();
  private readonly cameraPosition = new Vector3();
  private readonly sphere = new Sphere();
  private readonly selectedGeneration = new WeakMap<PointLight, number>();
  private generation = 0;

  /** Allocates ranking storage once for the renderer's fixed GPU light capacity. */
  constructor(private readonly capacity: number) {
    this.scores = new Float64Array(capacity);
  }

  /** Keeps the strongest camera-relevant sources in O(n log capacity), without per-frame ranking objects. */
  select(
    candidates: readonly PointLight[],
    camera: Camera,
    selected: PointLight[],
  ): void {
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.projection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(
      this.projection,
      camera.coordinateSystem,
    );
    let count = 0;
    for (const light of candidates) {
      const score = this.score(light);
      if (count < this.capacity) {
        let index = count++;
        while (index > 0) {
          const parent = (index - 1) >>> 1;
          if (!this.worse(score, light, this.scores[parent], selected[parent]))
            break;
          selected[index] = selected[parent];
          this.scores[index] = this.scores[parent];
          index = parent;
        }
        selected[index] = light;
        this.scores[index] = score;
      } else if (
        this.capacity > 0 &&
        this.worse(this.scores[0], selected[0], score, light)
      ) {
        let index = 0;
        while (index * 2 + 1 < count) {
          let child = index * 2 + 1;
          if (
            child + 1 < count &&
            this.worse(
              this.scores[child + 1],
              selected[child + 1],
              this.scores[child],
              selected[child],
            )
          )
            child++;
          if (!this.worse(this.scores[child], selected[child], score, light))
            break;
          selected[index] = selected[child];
          this.scores[index] = this.scores[child];
          index = child;
        }
        selected[index] = light;
        this.scores[index] = score;
      }
    }
    selected.length = count;
    this.generation++;
    for (const light of selected)
      this.selectedGeneration.set(light, this.generation);
  }

  /** Estimates visual importance from brightness and camera distance, conservatively rejecting off-screen bounds. */
  private score(light: PointLight): number {
    this.sphere.center.setFromMatrixPosition(light.matrixWorld);
    this.sphere.radius = light.distance;
    if (light.distance > 0 && !this.frustum.intersectsSphere(this.sphere))
      return -1;
    const split = light as PointLight & {
      splitColor?: boolean;
      secondaryColor?: Color;
    };
    let brightness = Math.max(0, light.color.r, light.color.g, light.color.b);
    if (split.splitColor && split.secondaryColor)
      brightness = Math.max(
        brightness,
        split.secondaryColor.r,
        split.secondaryColor.g,
        split.secondaryColor.b,
      );
    const score =
      (Math.max(0, light.intensity) * brightness) /
      Math.max(1, this.cameraPosition.distanceToSquared(this.sphere.center));
    if (!Number.isFinite(score)) return 0;
    return (
      score * (this.selectedGeneration.get(light) === this.generation ? 1.1 : 1)
    );
  }

  /** Equal priorities consistently favor the older source instead of scene traversal order. */
  private worse(
    leftScore: number,
    left: PointLight,
    rightScore: number,
    right: PointLight,
  ): boolean {
    return (
      leftScore < rightScore || (leftScore === rightScore && left.id > right.id)
    );
  }
}
