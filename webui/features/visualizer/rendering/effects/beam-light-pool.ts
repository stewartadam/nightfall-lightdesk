// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * A fixed pool of spot lights that light stage surfaces for GDTF beams.
 *
 * Every lit material's shader loops over every light in the scene, and
 * adding, removing or hiding a light recompiles those shaders. The pool
 * therefore keeps a constant set of lights in the scene and, each frame,
 * points them at the brightest beam light proxies (see beam-light-proxies);
 * unused lights stay in place at zero intensity.
 */

import { Object3D, type Scene, SpotLight, Texture } from "three/webgpu";
import type { BeamLightProxy } from "./beam-light-proxies";

/** Number of spot lights shared by all GDTF beams. */
export const BEAM_LIGHT_POOL_SIZE = 12;

/** Reach of pooled lights, in meters. */
const LIGHT_DISTANCE = 50;

/**
 * Returns a white image for a light that projected a gobo and is now open.
 *
 * It matches the size of the image it replaces, since resizing a map in
 * place does not reliably reallocate its GPU texture.
 */
function openProjectionImage(width: number, height: number): ImageData {
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.fill(255);
  return new ImageData(pixels, width, height);
}

/** One pooled light and the gobo image it currently projects. */
interface PoolSlot {
  light: SpotLight;
  target: Object3D;
  gobo: Texture | null;
}

/** Fixed set of spot lights assigned to beam light proxies each frame. */
export class BeamLightPool {
  private readonly slots: PoolSlot[] = [];

  /** Adds `size` spot lights to the scene, all dark until assigned. */
  constructor(scene: Scene, size = BEAM_LIGHT_POOL_SIZE) {
    for (let index = 0; index < size; index++) {
      const light = new SpotLight(0xffffff, 0);
      light.name = `BeamLight_${index}`;
      light.penumbra = 0.5;
      light.decay = 2;
      light.distance = LIGHT_DISTANCE;
      light.castShadow = false;
      const target = new Object3D();
      target.name = `BeamLightTarget_${index}`;
      light.target = target;
      scene.add(light, target);
      this.slots.push({ light, target, gobo: null });
    }
  }

  /** Returns the pooled lights, for inspection. */
  get lights(): SpotLight[] {
    return this.slots.map((slot) => slot.light);
  }

  /**
   * Points the pool at the brightest proxies and darkens the remaining lights.
   *
   * Proxies are ranked by intensity; when there are more proxies than
   * lights, the dimmest proxies do not light surfaces this frame.
   */
  assign(proxies: readonly BeamLightProxy[]): void {
    const ranked = [...proxies].sort((a, b) => b.intensity - a.intensity);
    this.slots.forEach((slot, index) => {
      const proxy = ranked[index];
      const { light, target } = slot;
      if (!proxy) {
        light.intensity = 0;
        light.userData = {};
        this.setGobo(slot, null);
        return;
      }
      light.position.copy(proxy.position);
      target.position.copy(proxy.position).add(proxy.direction);
      light.angle = proxy.halfAngle;
      light.intensity = proxy.intensity;
      light.color.setRGB(proxy.red, proxy.green, proxy.blue);
      light.updateMatrixWorld();
      target.updateMatrixWorld();
      // Scene inspection (debug tools, e2e) reads what each light stands for.
      light.userData = {
        fixtureUid: proxy.fixtureUid,
        beamCount: proxy.beamCount,
        projectsGobo: proxy.gobo instanceof Texture,
      };
      this.setGobo(slot, proxy.gobo instanceof Texture ? proxy.gobo : null);
    });
  }

  /**
   * Projects a gobo image from a pooled light, or white when `gobo` is null.
   *
   * Lit materials key their pipelines on each light's map texture, so each
   * light keeps one map, created with its first gobo, and only that map's
   * image changes; the map is replaced only for a gobo of a different image
   * size. Lights that never project a gobo get no map and no sampler.
   */
  private setGobo(slot: PoolSlot, gobo: Texture | null): void {
    if (slot.gobo === gobo) return;
    slot.gobo = gobo;
    let map = slot.light.map;
    const current = map?.image as { width: number; height: number } | undefined;
    const next = gobo?.image as { width: number; height: number } | undefined;
    if (
      map &&
      current &&
      next &&
      (current.width !== next.width || current.height !== next.height)
    ) {
      map.dispose();
      map = null;
    }
    if (!map) {
      if (!gobo) return;
      map = new Texture();
      map.flipY = false;
      slot.light.map = map;
    }
    if (gobo) {
      map.image = gobo.image;
    } else {
      const { width, height } = map.image as { width: number; height: number };
      map.image = openProjectionImage(width, height);
    }
    map.needsUpdate = true;
  }

  /** Removes the pooled lights from the scene and releases their maps. */
  dispose(): void {
    for (const { light, target } of this.slots) {
      light.map?.dispose();
      light.dispose();
      light.removeFromParent();
      target.removeFromParent();
    }
    this.slots.length = 0;
  }
}
