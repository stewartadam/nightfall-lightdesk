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
import type { ExtendedFixtureInstance } from "../fixture-renderers";
import type { EmitterColor } from "../geometry-builder";
import { gdtfWheelMediaUrl } from "../mesh-loader";
import type { BeamManager } from "./beam-manager";

/**
 * Extended color data with optional beam parameters.
 */
export interface BeamColorData extends EmitterColor {
  zoom?: number;
  frost?: number;
  /** Beam angle in degrees stated by the profile's zoom function. */
  zoomDegrees?: number;
  /** Iris aperture as a fraction of the open beam. */
  iris?: number;
}

/**
 * BeamUpdater handles beam synchronization for fixtures.
 * Shared between SceneManager (main thread) and worker mode.
 */
export class BeamUpdater {
  private beamManager: BeamManager;
  private enabled = true;

  constructor(beamManager: BeamManager) {
    this.beamManager = beamManager;
  }

  /**
   * Enable or disable beam updates.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
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
  }

  /**
   * Update beams for a single GDTF fixture based on emitter colors.
   * Creates a beam for each emitter in the fixture.
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
    if (instance.rendererType !== "gdtf") return;
    if (instance.emitters.size === 0) return;
    // Skip spotlight rendering for Glow beam types (LED bars, pixel fixtures)
    if (instance.beamType === BeamType.Glow) return;

    // Create/update a beam for each emitter
    for (const [emitterName, emitter] of instance.emitters) {
      if (!emitter.nodeGroup) continue;

      const beamId = `${uid}:${emitterName}`;
      const beamColor = elementColors.get(emitter.controlledElement);

      if (beamColor && beamColor.intensity > 0.01) {
        // Create or get beam, attach to emitter's node group
        const beam = this.beamManager.getOrCreateBeam(
          beamId,
          emitter.nodeGroup,
        );
        if (beam) {
          const goboMedia = beamColor.gobo
            ? instance.goboMedia?.get(emitter.controlledElement)?.[
                beamColor.gobo - 1
              ]
            : undefined;
          const gdtfPath = instance.geometry?.gdtfPath;
          this.beamManager.updateBeam(beamId, beamColor, {
            zoom: beamColor.zoom,
            zoomDegrees: beamColor.zoomDegrees,
            iris: beamColor.iris,
            frost: beamColor.frost,
            goboUrl:
              goboMedia && gdtfPath
                ? gdtfWheelMediaUrl(
                    gdtfPath,
                    goboMedia,
                    instance.geometry?.gdtfRevision,
                  )
                : undefined,
          });
        }
      } else {
        // Hide beam when intensity is too low
        this.beamManager.hideBeam(beamId);
      }
    }
  }

  /**
   * Dispose all beams.
   */
  dispose(): void {
    this.beamManager.dispose();
  }
}
