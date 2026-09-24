// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Volumetric beam material for visualizer theatrical lighting visualization.
 * Uses UV-based cone rendering with additive blending for volumetric appearance.
 *
 * Ported from vis1's beam-material.ts with minimal modifications.
 */

import { AdditiveBlending, ConeGeometry, DoubleSide, Vector3 } from "three";
import {
  abs,
  atan,
  cameraFar,
  cameraNear,
  cameraPosition,
  clamp,
  dot,
  Fn,
  float,
  floor,
  length,
  linearDepth,
  max,
  mix,
  mod,
  normalize,
  positionWorld,
  pow,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { VisualizerBeamQuality } from "../../../../lib/feature-flags";

// Default values for beam parameters
export const MIN_CONE_ANGLE_DEGREES = 4;
export const MAX_CONE_ANGLE_DEGREES = 70;
const DEFAULT_FALLOFF_RATE = 1.5;
const DEFAULT_MIN_ALPHA = 0.01;
const DEFAULT_SCATTERING_G = 0.7;
const DEFAULT_EXTINCTION_COEFF = 0.15;
const DEFAULT_AIR_DENSITY = 0.4;
const DEFAULT_SOFT_FADE_RANGE = 0.5;
const DEFAULT_SOFT_INTERSECTION_FADE = 1.0;
const DEFAULT_NEAR_FADE_START = 0.1;
const DEFAULT_NEAR_FADE_END = 0.5;
const DEFAULT_FROST_AMOUNT = 0.0;
const DEFAULT_PRISM_ACTIVE = 0.0;
const DEFAULT_PRISM_FACETS = 3.0;
const DEFAULT_PRISM_ROTATION = 0.0;
const DEFAULT_PRISM_SEPARATION = 0.15;
const DEFAULT_PRISM_CHROMATIC = 0.02;
const DEFAULT_NOISE_SCALE = 2.0;
const DEFAULT_NOISE_AMOUNT = 0.3;
const DEFAULT_BEAM_LENGTH = 50.0;
const LOW_QUALITY_BEAM_MAX_OPACITY = 0.3;
const LOW_QUALITY_BEAM_OPACITY_SCALE = 0.5;
const LOW_QUALITY_FLOOR_FADE_RANGE = 0.45;

export interface BeamParameters {
  color: [number, number, number, number];
  secondaryColor: [number, number, number];
  splitColorAmount: number;
  intensity: number;
  coneAngleDegrees: number;
  falloffRate: number;
  minAlpha: number;
  scatteringG: number;
  extinctionCoeff: number;
  airDensity: number;
  beamDirection: Vector3;
  beamOrigin: Vector3;
  softFadeRange: number;
  softIntersectionFade: number;
  nearFadeStart: number;
  nearFadeEnd: number;
  frostAmount: number;
  prismActive: number;
  prismFacets: number;
  prismRotation: number;
  prismSeparation: number;
  prismChromatic: number;
  noiseScale: number;
  noiseAmount: number;
  clipY: number;
  beamLength: number;
}

export const defaultBeamParameters: BeamParameters = {
  color: [0.35, 0.55, 1.0, 0.6],
  secondaryColor: [0.35, 0.55, 1.0],
  splitColorAmount: 0,
  intensity: 0.85,
  coneAngleDegrees: 28,
  falloffRate: DEFAULT_FALLOFF_RATE,
  minAlpha: DEFAULT_MIN_ALPHA,
  scatteringG: DEFAULT_SCATTERING_G,
  extinctionCoeff: DEFAULT_EXTINCTION_COEFF,
  airDensity: DEFAULT_AIR_DENSITY,
  beamDirection: new Vector3(0, -1, 0),
  beamOrigin: new Vector3(0, 0, 0),
  softFadeRange: DEFAULT_SOFT_FADE_RANGE,
  softIntersectionFade: DEFAULT_SOFT_INTERSECTION_FADE,
  nearFadeStart: DEFAULT_NEAR_FADE_START,
  nearFadeEnd: DEFAULT_NEAR_FADE_END,
  frostAmount: DEFAULT_FROST_AMOUNT,
  prismActive: DEFAULT_PRISM_ACTIVE,
  prismFacets: DEFAULT_PRISM_FACETS,
  prismRotation: DEFAULT_PRISM_ROTATION,
  prismSeparation: DEFAULT_PRISM_SEPARATION,
  prismChromatic: DEFAULT_PRISM_CHROMATIC,
  noiseScale: DEFAULT_NOISE_SCALE,
  noiseAmount: DEFAULT_NOISE_AMOUNT,
  clipY: -1000.0,
  beamLength: DEFAULT_BEAM_LENGTH,
};

/**
 * Henyey-Greenstein phase function for anisotropic scattering.
 * Models how light scatters based on the angle between view and beam direction.
 */
const henyeyGreenstein = Fn(([cosTheta, g]: [any, any]) => {
  const g2 = g.mul(g);
  const denom = float(1.0).add(g2).sub(g.mul(2.0).mul(cosTheta));
  return float(1.0)
    .sub(g2)
    .div(denom.pow(1.5).mul(4.0 * Math.PI));
});

type BeamUniform<T> = {
  value: T;
};

export interface BeamMaterialWithUniforms extends MeshBasicNodeMaterial {
  beamColorUniform: BeamUniform<Vector3>;
  secondaryBeamColorUniform: BeamUniform<Vector3>;
  splitColorAmountUniform: BeamUniform<number>;
  beamIntensityUniform: BeamUniform<number>;
  falloffRateUniform: BeamUniform<number>;
  minAlphaUniform: BeamUniform<number>;
  scatteringGUniform: BeamUniform<number>;
  extinctionCoeffUniform: BeamUniform<number>;
  airDensityUniform: BeamUniform<number>;
  beamDirectionUniform: BeamUniform<Vector3>;
  beamOriginUniform: BeamUniform<Vector3>;
  softFadeRangeUniform: BeamUniform<number>;
  softIntersectionFadeUniform: BeamUniform<number>;
  nearFadeStartUniform: BeamUniform<number>;
  nearFadeEndUniform: BeamUniform<number>;
  frostAmountUniform: BeamUniform<number>;
  prismActiveUniform: BeamUniform<number>;
  prismFacetsUniform: BeamUniform<number>;
  prismRotationUniform: BeamUniform<number>;
  prismSeparationUniform: BeamUniform<number>;
  prismChromaticUniform: BeamUniform<number>;
  noiseScaleUniform: BeamUniform<number>;
  noiseAmountUniform: BeamUniform<number>;
  clipYUniform: BeamUniform<number>;
  beamLengthUniform: BeamUniform<number>;
}

export interface LowQualityBeamMaterial extends MeshBasicNodeMaterial {
  isLowQualityBeamMaterial: true;
  lowQualityColorUniform: BeamUniform<Vector3>;
  lowQualityOpacityUniform: BeamUniform<number>;
  lowQualityClipYUniform: BeamUniform<number>;
}

export type BeamMaterial = BeamMaterialWithUniforms | LowQualityBeamMaterial;

/** Returns whether a beam material uses the low-quality render path. */
export function isLowQualityBeamMaterial(
  material: BeamMaterial,
): material is LowQualityBeamMaterial {
  return "isLowQualityBeamMaterial" in material;
}

/**
 * Creates a volumetric beam material with TSL shaders.
 * UV coordinates: x: 0 at edges, 1 at center; y: 1 at tip, 0 at base.
 */
export function createBeamMaterial(
  quality: VisualizerBeamQuality = "high",
): BeamMaterial {
  if (quality === "low") {
    return createLowQualityBeamMaterial();
  }

  const params = defaultBeamParameters;

  // Create uniforms
  const beamColorUniform = uniform(
    new Vector3(params.color[0], params.color[1], params.color[2]),
  );
  const secondaryBeamColorUniform = uniform(
    new Vector3(
      params.secondaryColor[0],
      params.secondaryColor[1],
      params.secondaryColor[2],
    ),
  );
  const splitColorAmountUniform = uniform(params.splitColorAmount);
  const beamIntensityUniform = uniform(params.intensity);
  const falloffRateUniform = uniform(params.falloffRate);
  const minAlphaUniform = uniform(params.minAlpha);
  const scatteringGUniform = uniform(params.scatteringG);
  const extinctionCoeffUniform = uniform(params.extinctionCoeff);
  const airDensityUniform = uniform(params.airDensity);
  const beamDirectionUniform = uniform(params.beamDirection);
  const beamOriginUniform = uniform(params.beamOrigin);
  const softFadeRangeUniform = uniform(params.softFadeRange);
  const softIntersectionFadeUniform = uniform(params.softIntersectionFade);
  const nearFadeStartUniform = uniform(params.nearFadeStart);
  const nearFadeEndUniform = uniform(params.nearFadeEnd);
  const frostAmountUniform = uniform(params.frostAmount);
  const prismActiveUniform = uniform(params.prismActive);
  const prismFacetsUniform = uniform(params.prismFacets);
  const prismRotationUniform = uniform(params.prismRotation);
  const prismSeparationUniform = uniform(params.prismSeparation);
  const prismChromaticUniform = uniform(params.prismChromatic);
  const noiseScaleUniform = uniform(params.noiseScale);
  const noiseAmountUniform = uniform(params.noiseAmount);
  const clipYUniform = uniform(params.clipY);
  const beamLengthUniform = uniform(params.beamLength);

  // Calculate super-Gaussian radial falloff for chromatic aberration.
  const calculateRadialFalloff = Fn(
    ([radius, edgeRadiusVal, edgeExponentVal]: [any, any, any]) => {
      const normalizedRadius = radius.div(edgeRadiusVal);
      const falloff = pow(
        float(Math.E),
        pow(normalizedRadius, edgeExponentVal).negate(),
      );
      return clamp(falloff, float(0.0), float(1.0));
    },
  );

  // Beam shader using UV coordinates
  // UV.x: 0 at edges, 1 at center (radial position on cone surface)
  // UV.y: 1 at tip (light source), 0 at base (far end)
  const beamShader = Fn(() => {
    const uvCoord = uv();
    const radialPos = abs(uvCoord.x.sub(0.5)).mul(2.0); // 0 at center, 1 at edges
    // Invert so 0 = tip (light source), 1 = base (far end)
    const axialPos = float(1.0).sub(uvCoord.y);

    // Axial fade: strongest near tip, fading toward base
    const axialFade = pow(float(1.0).sub(axialPos), falloffRateUniform);

    // Super-Gaussian radial edge profile controlled by frost
    const edgeExponent = mix(float(6.0), float(2.0), frostAmountUniform);
    const edgeRadius = mix(float(0.6), float(0.3), frostAmountUniform);
    const normalizedRadius = radialPos.div(edgeRadius);
    const edgeSoftness = clamp(
      pow(float(Math.E), pow(normalizedRadius, edgeExponent).negate()),
      float(0.0),
      float(1.0),
    );

    // Frost reduces peak intensity
    const frostReduction = float(1.0).sub(frostAmountUniform.mul(0.3));

    // View-dependent scattering using Henyey-Greenstein phase function
    const worldPos = positionWorld;
    const viewDir = normalize(cameraPosition.sub(worldPos));
    const beamDir = normalize(beamDirectionUniform);
    const cosTheta = clamp(dot(viewDir, beamDir), -1.0, 1.0);
    const phase = henyeyGreenstein(cosTheta, scatteringGUniform);
    const normalizedPhase = phase.mul(0.15).add(0.85);

    // Distance-based attenuation
    const distanceMeters = axialPos.mul(beamLengthUniform);
    const refDist = float(5.0);
    const falloffFactor = refDist.div(refDist.add(distanceMeters));
    const distanceFalloff = falloffFactor.mul(falloffFactor);
    const extinction = pow(
      float(Math.E),
      extinctionCoeffUniform.mul(0.3).negate().mul(distanceMeters),
    );
    const distanceAttenuation = distanceFalloff.mul(extinction);

    const effectiveIntensity = beamIntensityUniform.mul(frostReduction);
    const splitSelector = splitColorAmountUniform.mul(
      smoothstep(float(0.49), float(0.51), uvCoord.x),
    );
    const beamBaseColor = mix(
      beamColorUniform,
      secondaryBeamColorUniform,
      splitSelector,
    );

    // Prism multi-beam splitting with chromatic aberration
    const centeredX = uvCoord.x.sub(0.5);
    const centeredY = uvCoord.y.sub(0.5);
    const polarAngle = atan(centeredY, centeredX);
    const polarRadius = length(vec2(centeredX, centeredY)).mul(2.0);

    const facetAngle = float(2.0 * Math.PI).div(prismFacetsUniform);
    const rotatedAngle = polarAngle.sub(prismRotationUniform);
    const facetIndex = floor(rotatedAngle.div(facetAngle).add(0.5));
    const nearestFacetAngle = facetIndex
      .mul(facetAngle)
      .add(prismRotationUniform);

    const angleToFacet = abs(polarAngle.sub(nearestFacetAngle));
    const wrappedAngle = mod(angleToFacet.add(Math.PI), 2.0 * Math.PI).sub(
      Math.PI,
    );
    const absWrappedAngle = abs(wrappedAngle);

    const facetBeamWidth = prismSeparationUniform.mul(0.5);
    const facetFalloff = float(1.0).sub(
      smoothstep(float(0.0), facetBeamWidth, absWrappedAngle),
    );

    // Chromatic aberration
    const chromaticOffset = prismChromaticUniform.mul(polarRadius);
    const radiusR = polarRadius.add(chromaticOffset);
    const radiusG = polarRadius;
    const radiusB = polarRadius.sub(chromaticOffset);

    const falloffR = calculateRadialFalloff(
      radiusR.mul(0.5),
      edgeRadius,
      edgeExponent,
    );
    const falloffG = calculateRadialFalloff(
      radiusG.mul(0.5),
      edgeRadius,
      edgeExponent,
    );
    const falloffB = calculateRadialFalloff(
      radiusB.mul(0.5),
      edgeRadius,
      edgeExponent,
    );

    const prismEdgeSoftness = mix(
      edgeSoftness,
      facetFalloff.mul(edgeSoftness),
      prismActiveUniform,
    );
    const prismColor = mix(
      beamBaseColor,
      vec3(
        beamBaseColor.x.mul(falloffR),
        beamBaseColor.y.mul(falloffG),
        beamBaseColor.z.mul(falloffB),
      ),
      prismActiveUniform.mul(prismChromaticUniform.mul(10.0)).min(1.0),
    );

    const baseAlpha = axialFade
      .mul(prismEdgeSoftness)
      .mul(distanceAttenuation)
      .mul(normalizedPhase)
      .mul(effectiveIntensity);

    // Near-plane fade
    const fragmentDepth = linearDepth();
    const depthRange = cameraFar.sub(cameraNear);
    const nearFade = smoothstep(
      nearFadeStartUniform,
      nearFadeEndUniform,
      fragmentDepth.mul(depthRange),
    );

    const fadedAlpha = baseAlpha.mul(nearFade);

    // Floor clipping
    const fadeZone = float(0.02);
    const floorFade = smoothstep(
      clipYUniform.sub(fadeZone),
      clipYUniform,
      worldPos.y,
    );
    const clippedAlpha = fadedAlpha.mul(floorFade);

    const finalAlpha = max(clippedAlpha, minAlphaUniform.mul(floorFade)).min(
      1.0,
    );

    // Emissive boost
    const boost = float(1.0).add(beamIntensityUniform.mul(0.4));
    const emissive = prismColor.mul(boost);

    return vec4(emissive, finalAlpha.mul(params.color[3]));
  });

  const material = new MeshBasicNodeMaterial() as BeamMaterialWithUniforms;
  material.colorNode = beamShader();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  material.side = DoubleSide;
  material.forceSinglePass = true;

  // Attach uniforms for later updates
  material.beamColorUniform = beamColorUniform;
  material.secondaryBeamColorUniform = secondaryBeamColorUniform;
  material.splitColorAmountUniform = splitColorAmountUniform;
  material.beamIntensityUniform = beamIntensityUniform;
  material.falloffRateUniform = falloffRateUniform;
  material.minAlphaUniform = minAlphaUniform;
  material.scatteringGUniform = scatteringGUniform;
  material.extinctionCoeffUniform = extinctionCoeffUniform;
  material.airDensityUniform = airDensityUniform;
  material.beamDirectionUniform = beamDirectionUniform;
  material.beamOriginUniform = beamOriginUniform;
  material.softFadeRangeUniform = softFadeRangeUniform;
  material.softIntersectionFadeUniform = softIntersectionFadeUniform;
  material.nearFadeStartUniform = nearFadeStartUniform;
  material.nearFadeEndUniform = nearFadeEndUniform;
  material.frostAmountUniform = frostAmountUniform;
  material.prismActiveUniform = prismActiveUniform;
  material.prismFacetsUniform = prismFacetsUniform;
  material.prismRotationUniform = prismRotationUniform;
  material.prismSeparationUniform = prismSeparationUniform;
  material.prismChromaticUniform = prismChromaticUniform;
  material.noiseScaleUniform = noiseScaleUniform;
  material.noiseAmountUniform = noiseAmountUniform;
  material.clipYUniform = clipYUniform;
  material.beamLengthUniform = beamLengthUniform;

  return material;
}

/** Creates a cheap additive cone material for low-quality beam rendering. */
function createLowQualityBeamMaterial(): LowQualityBeamMaterial {
  const beamColorUniform = uniform(new Vector3(1, 1, 1));
  const beamOpacityUniform = uniform(0);
  const clipYUniform = uniform(defaultBeamParameters.clipY);
  const floorFade = smoothstep(
    clipYUniform,
    clipYUniform.add(LOW_QUALITY_FLOOR_FADE_RANGE),
    positionWorld.y,
  );

  const material = new MeshBasicNodeMaterial() as LowQualityBeamMaterial;
  material.colorNode = vec4(
    beamColorUniform,
    beamOpacityUniform.mul(floorFade),
  );
  material.transparent = true;
  material.opacity = 0;
  material.depthTest = true;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  material.side = DoubleSide;
  material.forceSinglePass = true;
  material.isLowQualityBeamMaterial = true;
  material.lowQualityColorUniform = beamColorUniform;
  material.lowQualityOpacityUniform = beamOpacityUniform;
  material.lowQualityClipYUniform = clipYUniform;
  return material;
}

/**
 * Updates beam material uniforms from parameters.
 */
export function updateBeamMaterial(
  material: BeamMaterial,
  params: BeamParameters,
): void {
  if (isLowQualityBeamMaterial(material)) {
    const opacity =
      params.intensity > 0.01
        ? Math.min(
            LOW_QUALITY_BEAM_MAX_OPACITY,
            params.intensity * params.color[3] * LOW_QUALITY_BEAM_OPACITY_SCALE,
          )
        : 0;
    material.lowQualityColorUniform.value.set(
      params.color[0],
      params.color[1],
      params.color[2],
    );
    material.lowQualityOpacityUniform.value = opacity;
    material.lowQualityClipYUniform.value = params.clipY;
    material.opacity = opacity;
    return;
  }

  material.beamColorUniform.value.set(
    params.color[0],
    params.color[1],
    params.color[2],
  );
  material.secondaryBeamColorUniform.value.set(
    params.secondaryColor[0],
    params.secondaryColor[1],
    params.secondaryColor[2],
  );
  material.splitColorAmountUniform.value = params.splitColorAmount;
  material.beamIntensityUniform.value = params.intensity;
  material.falloffRateUniform.value = params.falloffRate;
  material.minAlphaUniform.value = params.minAlpha;
  material.scatteringGUniform.value = params.scatteringG;
  material.extinctionCoeffUniform.value = params.extinctionCoeff;
  material.airDensityUniform.value = params.airDensity;
  material.beamDirectionUniform.value.copy(params.beamDirection);
  material.beamOriginUniform.value.copy(params.beamOrigin);
  material.softFadeRangeUniform.value = params.softFadeRange;
  material.softIntersectionFadeUniform.value = params.softIntersectionFade;
  material.nearFadeStartUniform.value = params.nearFadeStart;
  material.nearFadeEndUniform.value = params.nearFadeEnd;
  material.frostAmountUniform.value = params.frostAmount;
  material.prismActiveUniform.value = params.prismActive;
  material.prismFacetsUniform.value = params.prismFacets;
  material.prismRotationUniform.value = params.prismRotation;
  material.prismSeparationUniform.value = params.prismSeparation;
  material.prismChromaticUniform.value = params.prismChromatic;
  material.noiseScaleUniform.value = params.noiseScale;
  material.noiseAmountUniform.value = params.noiseAmount;
  material.clipYUniform.value = params.clipY;
  material.beamLengthUniform.value = params.beamLength;
}

/**
 * Creates a unit cone geometry for the beam volume.
 * Tip at origin, base extending downward. Scale dynamically for actual dimensions.
 */
export function createBeamGeometry(
  quality: VisualizerBeamQuality = "high",
): ConeGeometry {
  const radialSegments = quality === "low" ? 12 : 64;
  return new ConeGeometry(1.0, 1.0, radialSegments, 1, true);
}

/**
 * Disposes beam material resources.
 */
export function disposeBeamMaterial(material: BeamMaterial): void {
  material.dispose();
}
