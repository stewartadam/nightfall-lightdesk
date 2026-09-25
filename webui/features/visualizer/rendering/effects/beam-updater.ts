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

import { BeamType } from "../../../../types";
import type { EmitterData } from "../../model/types";
import type { ExtendedFixtureInstance } from "../fixture-renderers";
import type { EmitterColor } from "../geometry-builder";
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

/**
 * BeamUpdater handles beam synchronization for fixtures.
 * Shared between SceneManager (main thread) and worker mode.
 */
export class BeamUpdater {
  private beamManager: BeamManager;
  private enabled = true;
  private readonly reducedPrisms = new Set<EmitterData>();

  /** Counts illuminated emitters whose current prism split exceeds the prepared rendering budget. */
  get reducedPrismEmitters(): number {
    return this.reducedPrisms.size;
  }
  private readonly opticalStates = new WeakMap<
    EmitterData,
    EmitterOpticalState
  >();

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
      this.beamManager.dispose();
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
        if (!this.opticalStates.has(emitter))
          this.opticalStates.set(
            emitter,
            new EmitterOpticalState(emitter, (path, media) =>
              this.beamManager.loadGobo(path, media),
            ),
          );
        if (emitter.optics)
          this.beamManager.reserveOpticalBeam(
            `${uid}:${name}`,
            this.opticalStates.get(emitter)!.maxFacetCount,
          );
      }
    for (const emitter of this.reducedPrisms)
      if (!live.has(emitter)) this.reducedPrisms.delete(emitter);
  }

  /**
   * Updates a fixture's defined optical apertures from independently controlled emitter colors.
   * Legacy fixture renderers retain ownership of their projection until they opt into shared atmosphere.
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
    if (
      (instance.movingHeadData && !instance.movingHeadData.sharedAtmosphere) ||
      (instance.rotatingWashBeamData &&
        !instance.rotatingWashBeamData.sharedAtmosphere)
    )
      return;
    if (instance.emitters.size === 0) return;

    // Create/update a beam for each emitter
    for (const [emitterName, emitter] of instance.emitters) {
      if (!emitter.nodeGroup) {
        this.reducedPrisms.delete(emitter);
        continue;
      }
      const beamId = `${uid}:${emitterName}`;
      const beamColor =
        emitter.beamColor ?? elementColors.get(emitter.controlledElement);
      if (emitter.optics) {
        const opticalState = this.opticalStates.get(emitter);
        opticalState?.update(elementColors);
        if (
          opticalState?.prismReduced &&
          beamColor &&
          beamColor.intensity > 0.01
        )
          this.reducedPrisms.add(emitter);
        else this.reducedPrisms.delete(emitter);
        if (beamColor && beamColor.intensity > 0.01)
          this.beamManager.updateOpticalBeam(
            beamId,
            emitter.nodeGroup,
            emitter.optics,
            beamColor,
            opticalState?.zoomDegrees ?? beamColor.zoomDegrees,
            opticalState?.goboSlot,
            opticalState?.goboRotation,
            opticalState?.prism,
            opticalState?.prismRotation,
            opticalState?.focusDistance,
            opticalState?.gobos,
          );
        else this.beamManager.removeOpticalBeam(beamId);
        continue;
      }
      if (instance.rendererType !== "gdtf") continue;
      // Mixed fixtures can contain both projecting apertures and glow-only pixels.
      if (instance.beamType === BeamType.Glow) continue;

      if (beamColor && beamColor.intensity > 0.01) {
        // Create or get beam, attach to emitter's node group
        const beam = this.beamManager.getOrCreateBeam(
          beamId,
          emitter.nodeGroup,
        );
        if (beam) {
          this.beamManager.updateBeam(beamId, beamColor, {
            zoom: beamColor.zoom,
            frost: beamColor.frost,
          });
        }
      } else if (this.beamManager.hasBeam(beamId)) {
        // Hide beam when intensity is too low
        const beam = this.beamManager.getBeam(beamId);
        if (beam) {
          beam.mesh.visible = false;
          beam.spotLight.visible = false;
        }
      }
    }
  }

  /**
   * Dispose all beams.
   */
  dispose(): void {
    this.reducedPrisms.clear();
    this.beamManager.destroy();
  }
}
