// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Beam updater for visualizer fixtures.
 * Encapsulates beam update logic for use in both main thread and worker modes.
 */

import type { EmitterData } from "../../model/types";
import { VISIBLE_INTENSITY_THRESHOLD } from "../emitter-radiance";
import type { ExtendedFixtureInstance } from "../fixture-renderers";
import type { EmitterColor } from "../geometry-builder";
import { apertureId } from "./aperture-id";
import type { BeamManager } from "./beam-manager";
import { EmitterOpticalState } from "./emitter-optical-state";

/**
 * Extended color data with optional beam parameters.
 */
export interface BeamColorData extends EmitterColor {
  zoom?: number;
  zoomDegrees?: number;
  frost?: number;
}

/** A projecting emitter's batch identifier and compiled optical controls. */
interface Aperture {
  id: string;
  controls: EmitterOpticalState;
}

/**
 * BeamUpdater handles beam synchronization for fixtures.
 * Shared between SceneManager (main thread) and worker mode.
 */
export class BeamUpdater {
  private beamManager: BeamManager;
  private enabled = true;
  private readonly reducedPrisms = new Set<EmitterData>();
  /** Per-emitter state built once at sync, so playback allocates no identifiers or controls. */
  private readonly apertures = new WeakMap<EmitterData, Aperture>();

  /** Counts illuminated emitters whose current prism split exceeds the prepared rendering budget. */
  get reducedPrismEmitters(): number {
    return this.reducedPrisms.size;
  }

  /** Publishes apertures through the scene's beam manager. */
  constructor(beamManager: BeamManager) {
    this.beamManager = beamManager;
  }

  /**
   * Enable or disable beam updates.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.reducedPrisms.clear();
      this.beamManager.clear();
    }
  }

  /**
   * Check if beam updates are enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Sync beams with current fixture instances.
   * Call this when fixtures are added/removed.
   */
  syncWithFixtures(fixtures: Map<string, ExtendedFixtureInstance>): void {
    this.beamManager.syncWithFixtures(fixtures);
    const live = new Set<EmitterData>();
    for (const [uid, fixture] of fixtures)
      for (const [name, emitter] of fixture.emitters) {
        live.add(emitter);
        if (!emitter.optics) continue;
        const aperture = this.aperture(uid, name, emitter);
        this.beamManager.reserveOpticalBeam(
          aperture.id,
          aperture.controls.maxFacetCount,
        );
      }
    for (const emitter of this.reducedPrisms)
      if (!live.has(emitter)) this.reducedPrisms.delete(emitter);
  }

  /** Returns an emitter's aperture state, compiling its optical controls on first use. */
  private aperture(uid: string, name: string, emitter: EmitterData): Aperture {
    let aperture = this.apertures.get(emitter);
    if (!aperture) {
      aperture = {
        id: apertureId(uid, name),
        controls: new EmitterOpticalState(emitter, (path, media) =>
          this.beamManager.loadGobo(path, media),
        ),
      };
      this.apertures.set(emitter, aperture);
    }
    return aperture;
  }

  /**
   * Updates a fixture's defined optical apertures from independently controlled emitter colors.
   * Every aperture is drawn by the scene's shared atmospheric and surface batch; dark apertures are removed.
   *
   * @param uid Fixture UID
   * @param instance Fixture instance
   * @param elementColors Map of element label -> color data
   */
  updateFixtureBeam(
    uid: string,
    instance: ExtendedFixtureInstance,
    elementColors: Map<string, BeamColorData>,
  ): void {
    if (!this.enabled) return;

    for (const [emitterName, emitter] of instance.emitters) {
      // Glow-only pixels have no aperture; only projecting emitters reach the shared batch.
      if (!emitter.nodeGroup || !emitter.optics) {
        this.reducedPrisms.delete(emitter);
        continue;
      }
      const { id, controls } = this.aperture(uid, emitterName, emitter);
      const beamColor =
        emitter.beamColor ?? elementColors.get(emitter.controlledElement);
      controls.update(elementColors);
      const lit =
        beamColor !== undefined &&
        beamColor.intensity > VISIBLE_INTENSITY_THRESHOLD;
      if (lit && controls.prismReduced) this.reducedPrisms.add(emitter);
      else this.reducedPrisms.delete(emitter);
      if (lit)
        this.beamManager.updateOpticalBeam(
          id,
          emitter.nodeGroup,
          emitter.optics,
          beamColor,
          controls,
        );
      else this.beamManager.removeOpticalBeam(id);
    }
  }

  /**
   * Dispose all beams.
   */
  dispose(): void {
    this.reducedPrisms.clear();
    this.beamManager.dispose();
  }
}
