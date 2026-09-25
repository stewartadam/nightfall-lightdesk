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
import type { VisualizerQualityPreset } from "../../state/settings";
import type { ExtendedFixtureInstance } from "../fixture-renderers";
import type { EmitterColor } from "../geometry-builder";
import { resolveEmitterOptics } from "./emitter-optics";
import { EmitterVolumeBatch } from "./emitter-volume-batch";
import type { PrismProjection } from "./prism-optics";

/**
 * BeamManager routes fixture apertures into the scene's shared atmospheric and surface batch.
 */
export class BeamManager {
  private readonly volumeBatch?: EmitterVolumeBatch;

  /** Reports illuminated emitters whose active masks exceed the shader sampling budget. */
  get reducedGoboEmitters(): number {
    return this.volumeBatch?.goboAtlas.stacks.reducedStacks ?? 0;
  }
  private readonly resolvedOptics = new WeakMap<
    BeamOptics,
    ReturnType<typeof resolveEmitterOptics>
  >();
  readonly beamQuality: VisualizerQualityPreset;

  constructor(scene: Scene, beamQuality: VisualizerQualityPreset = "high") {
    this.beamQuality = beamQuality;
    this.volumeBatch = new EmitterVolumeBatch(scene);
  }

  /** Resolves a source image once during fixture setup, including non-ASCII archive paths. */
  loadGobo(path: string, media: string) {
    if (this.beamQuality !== "high" || !this.volumeBatch)
      return { index: 0, status: "failed" as const };
    const bytes = new TextEncoder().encode(path);
    const encoded = btoa(
      Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return this.volumeBatch.goboAtlas.load(
      `${getBackendUrl()}/api/wheel-media/${encoded}/${encodeURIComponent(media)}`,
    );
  }

  /** Allocates imported prism capacity while fixture geometry is being synchronized. */
  reserveOpticalBeam(id: string, maxFacetCount: number): void {
    this.volumeBatch?.reserve(
      id,
      this.beamQuality === "high" ? maxFacetCount : 1,
    );
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
    gobos?: readonly import("./emitter-optical-state").GoboStage[],
  ): void {
    if (!this.volumeBatch) return;
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
        this.beamQuality === "high" ? goboSlot : 0,
        goboRotation,
        this.beamQuality === "high" ? facets : undefined,
        prismRotation,
        focusDistance,
        this.beamQuality === "high" ? gobos : undefined,
      );
    else this.volumeBatch.remove(id);
  }

  /** Removes an aperture immediately on blackout rather than retaining stale scattering. */
  removeOpticalBeam(id: string): void {
    this.volumeBatch?.remove(id);
  }

  /**
   * Drops apertures whose fixture or emitter no longer exists after fixture instances change.
   * Aperture IDs use the format "fixtureUid:emitterName".
   */
  syncWithFixtures(fixtures: Map<string, ExtendedFixtureInstance>): void {
    this.volumeBatch?.sync(fixtures);
  }

  /**
   * Dispose all beams.
   */
  dispose(): void {
    this.volumeBatch?.clear();
  }

  /** Releases shared GPU resources when the owning scene is destroyed. */
  destroy(): void {
    this.dispose();
    this.volumeBatch?.dispose();
  }
}
