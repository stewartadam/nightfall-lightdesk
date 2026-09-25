// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Beam manager for visualizer fixtures.
 * Publishes every emitter aperture into the scene's shared optical batch.
 */

import type { Object3D, Scene } from "three/webgpu";
import { getBackendUrl } from "../../../../lib/api";
import type { BeamOptics } from "../../../../types";
import type { ExtendedFixtureInstance } from "../fixture-renderers";
import type { EmitterColor } from "../geometry-builder";
import type { QualityProfile } from "../quality-profile";
import type { GoboStage } from "./emitter-optical-state";
import { resolveEmitterOptics } from "./emitter-optics";
import { EmitterVolumeBatch } from "./emitter-volume-batch";
import type { GoboAtlasSlot } from "./gobo-atlas";
import type { PrismProjection } from "./prism-optics";

/** Slot returned for gobo media the active quality profile never projects. */
const UNPROJECTED_GOBO: GoboAtlasSlot = { index: 0, status: "failed" };

/**
 * BeamManager routes fixture apertures into the scene's shared atmospheric and surface batch.
 */
export class BeamManager {
  private readonly volumeBatch: EmitterVolumeBatch;

  /** Reports illuminated emitters whose active masks exceed the shader sampling budget. */
  get reducedGoboEmitters(): number {
    return this.volumeBatch.goboAtlas?.stacks.reducedStacks ?? 0;
  }
  private readonly resolvedOptics = new WeakMap<
    BeamOptics,
    ReturnType<typeof resolveEmitterOptics>
  >();

  /** Creates the scene's shared batch, which adopts the quality profile of the scene's pipeline. */
  constructor(scene: Scene) {
    this.volumeBatch = new EmitterVolumeBatch(scene);
  }

  /** Capabilities of the pipeline drawing this scene's apertures. */
  private get profile(): QualityProfile {
    return this.volumeBatch.profile;
  }

  /** Resolves a source image once during fixture setup, including non-ASCII archive paths. */
  loadGobo(path: string, media: string): GoboAtlasSlot {
    const atlas = this.volumeBatch.goboAtlas;
    if (!atlas) return UNPROJECTED_GOBO;
    const bytes = new TextEncoder().encode(path);
    const encoded = btoa(
      Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return atlas.load(
      `${getBackendUrl()}/api/wheel-media/${encoded}/${encodeURIComponent(media)}`,
    );
  }

  /** Allocates imported prism capacity while fixture geometry is being synchronized. */
  reserveOpticalBeam(id: string, maxFacetCount: number): void {
    this.volumeBatch.reserve(id, this.profile.prismFacets ? maxFacetCount : 1);
  }

  /** Publishes one imported aperture to the shared atmospheric draw. */
  updateOpticalBeam(
    id: string,
    parent: Object3D,
    optics: BeamOptics,
    color: EmitterColor,
    zoomDegrees?: number,
    goboSlot = 0,
    goboRotation = 0,
    facets?: readonly PrismProjection[],
    prismRotation = 0,
    focusDistance = 0,
    gobos?: readonly GoboStage[],
  ): void {
    if (!this.resolvedOptics.has(optics))
      this.resolvedOptics.set(optics, resolveEmitterOptics(optics));
    const resolved = this.resolvedOptics.get(optics);
    const baseSlope = Math.tan((optics.physical.beamAngle * Math.PI) / 360);
    const zoomScale =
      zoomDegrees !== undefined &&
      Number.isFinite(zoomDegrees) &&
      baseSlope > 1e-6
        ? Math.tan((Math.max(0, Math.min(170, zoomDegrees)) * Math.PI) / 360) /
          baseSlope
        : 1;
    if (resolved)
      this.volumeBatch.update(
        id,
        parent,
        resolved,
        color,
        30,
        zoomScale,
        this.profile.gobos ? goboSlot : 0,
        goboRotation,
        this.profile.prismFacets ? facets : undefined,
        prismRotation,
        focusDistance,
        this.profile.gobos ? gobos : undefined,
      );
    else this.volumeBatch.remove(id);
  }

  /** Removes an aperture immediately on blackout rather than retaining stale scattering. */
  removeOpticalBeam(id: string): void {
    this.volumeBatch.remove(id);
  }

  /**
   * Drops apertures whose fixture or emitter no longer exists after fixture instances change.
   * Aperture IDs use the format "fixtureUid:emitterName".
   */
  syncWithFixtures(fixtures: Map<string, ExtendedFixtureInstance>): void {
    this.volumeBatch.sync(fixtures);
  }

  /**
   * Dispose all beams.
   */
  dispose(): void {
    this.volumeBatch.clear();
  }

  /** Releases shared GPU resources when the owning scene is destroyed. */
  destroy(): void {
    this.dispose();
    this.volumeBatch.dispose();
  }
}
