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
import type { ApertureControls } from "./emitter-optical-state";
import {
  emitterZoomScale,
  type ResolvedEmitterOptics,
  resolveEmitterOptics,
} from "./emitter-optics";
import { EmitterVolumeBatch } from "./emitter-volume-batch";
import type { GoboAtlasSlot } from "./gobo-atlas";

/** Slot returned for gobo media the active quality profile never projects. */
const UNPROJECTED_GOBO: GoboAtlasSlot = { index: 0, status: "failed" };

/**
 * BeamManager routes fixture apertures into the scene's shared atmospheric and surface batch.
 */
export class BeamManager {
  private readonly volumeBatch: EmitterVolumeBatch;
  /** Resolved distributions per imported optics record; Glow apertures resolve to undefined. */
  private readonly resolvedOptics = new WeakMap<
    BeamOptics,
    ResolvedEmitterOptics | undefined
  >();

  /** Creates the scene's shared batch, which adopts the quality profile of the scene's pipeline. */
  constructor(scene: Scene) {
    this.volumeBatch = new EmitterVolumeBatch(scene);
  }

  /** Reports illuminated emitters whose active masks exceed the shader sampling budget. */
  get reducedGoboEmitters(): number {
    return this.volumeBatch.goboAtlas?.stacks.reducedStacks ?? 0;
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
    this.volumeBatch.reserve(
      id,
      this.volumeBatch.profile.prismFacets ? maxFacetCount : 1,
    );
  }

  /**
   * Publishes one imported aperture to the shared atmospheric draw. A degree-valued zoom
   * channel takes precedence over the zoom angle the fixture renderer published with its color.
   */
  updateOpticalBeam(
    id: string,
    parent: Object3D,
    optics: BeamOptics,
    color: EmitterColor,
    controls: ApertureControls,
  ): void {
    const resolved = this.resolve(optics);
    if (!resolved) {
      this.volumeBatch.remove(id);
      return;
    }
    const { profile } = this.volumeBatch;
    this.volumeBatch.update(id, parent, {
      optics: resolved,
      color,
      zoomScale: emitterZoomScale(
        optics.physical,
        controls.zoomDegrees ?? color.zoomDegrees,
      ),
      gobos: profile.gobos ? controls.gobos : undefined,
      facets: profile.prismFacets ? controls.prism : undefined,
      prismRotation: controls.prismRotation,
      focusDistance: controls.focusDistance,
    });
  }

  /** Resolves an optics record once and reuses it for every later frame. */
  private resolve(optics: BeamOptics): ResolvedEmitterOptics | undefined {
    if (!this.resolvedOptics.has(optics))
      this.resolvedOptics.set(optics, resolveEmitterOptics(optics));
    return this.resolvedOptics.get(optics);
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

  /** Hides every aperture while keeping the shared batch's GPU buffers for reuse. */
  clear(): void {
    this.volumeBatch.clear();
  }

  /** Releases the shared batch's GPU resources when the owning scene is destroyed. */
  dispose(): void {
    this.volumeBatch.dispose();
  }
}
