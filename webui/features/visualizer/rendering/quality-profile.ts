// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Resolved rendering capabilities for each visualizer quality preset.
 *
 * Renderers are rebuilt whenever the preset changes, so a profile is resolved once at
 * construction and handed to every subsystem instead of each one comparing preset names.
 */

import type { VisualizerQualityPreset } from "../state/settings";
import {
  EMITTER_RADIANCE,
  UNBLOOMED_EMITTER_RADIANCE,
} from "./emitter-radiance";

/** How the shared atmospheric pass draws each emitter aperture. */
export type BeamStyle =
  /** Ray-marched single scattering through haze; the only style that projects gobos, prisms and shadows. */
  | { readonly kind: "volumetric" }
  /** Additive cone surfaces shaded to approximate scattering without ray marching or a fog pass. */
  | { readonly kind: "shaded-cone"; readonly segments: number }
  /** Flat cones max-blended so overlapping beams read as one schematic union rather than haze. */
  | { readonly kind: "schematic-cone"; readonly segments: number };

/** Every capability the visualizer varies by quality preset. */
export interface QualityProfile {
  readonly preset: VisualizerQualityPreset;
  readonly beamStyle: BeamStyle;
  /** Gobo wheel media is decoded and projected into beams and onto surfaces. */
  readonly gobos: boolean;
  /** Prism wheels split apertures into their declared facets instead of a single beam. */
  readonly prismFacets: boolean;
  /** Occluders render optical shadow maps sampled by surfaces and haze. */
  readonly shadows: boolean;
  /** Bright pixels spread into a bloom glow. */
  readonly bloom: boolean;
  /** Output is tone mapped into an LDR target and edge filtered with FXAA. */
  readonly fxaa: boolean;
  /** The atmosphere pass follows the GPU budget's resolution tier instead of a fixed scale. */
  readonly adaptiveAtmosphereResolution: boolean;
  /** Scale on luminous faces driven at EMITTER_RADIANCE, keeping unbloomed faces from clipping. */
  readonly emitterDisplayGain: number;
}

/** Scale on HDR emitter faces when no bloom pass spreads their excess energy. */
const UNBLOOMED_EMITTER_DISPLAY_GAIN =
  UNBLOOMED_EMITTER_RADIANCE / EMITTER_RADIANCE;

const QUALITY_PROFILES: Record<VisualizerQualityPreset, QualityProfile> = {
  low: {
    preset: "low",
    beamStyle: { kind: "schematic-cone", segments: 12 },
    gobos: false,
    prismFacets: false,
    shadows: false,
    bloom: false,
    fxaa: false,
    adaptiveAtmosphereResolution: false,
    emitterDisplayGain: UNBLOOMED_EMITTER_DISPLAY_GAIN,
  },
  medium: {
    preset: "medium",
    // Shaded surfaces reveal faceting, so medium spends more segments than the flat schematic cone.
    beamStyle: { kind: "shaded-cone", segments: 48 },
    gobos: false,
    prismFacets: false,
    shadows: false,
    bloom: false,
    fxaa: false,
    adaptiveAtmosphereResolution: false,
    emitterDisplayGain: UNBLOOMED_EMITTER_DISPLAY_GAIN,
  },
  high: {
    preset: "high",
    beamStyle: { kind: "volumetric" },
    gobos: true,
    prismFacets: true,
    shadows: true,
    bloom: true,
    fxaa: true,
    adaptiveAtmosphereResolution: true,
    emitterDisplayGain: 1,
  },
};

/** Returns the shared, immutable capability set for a quality preset. */
export function resolveQualityProfile(
  preset: VisualizerQualityPreset,
): QualityProfile {
  return QUALITY_PROFILES[preset];
}
