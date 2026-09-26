// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Moving head fixture renderer for Visualizer.
 * Renders moving head fixtures with pan/tilt movement; the beam itself is drawn by
 * the scene's shared optical batch from the head's aperture.
 *
 * Moving heads have:
 * - A base (static, pan rotation)
 * - A yoke (rotates for pan)
 * - A head (rotates for tilt, contains the light source)
 * - An optical aperture on the head's lens
 */

import {
  BoxGeometry,
  Color,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from "three/webgpu";
import type {
  FixtureElement,
  FixtureGeometry,
  FixturePhysical,
} from "../../../../types";
import { BeamType } from "../../../../types";
import { bindEmitterOpticalChannels } from "../../model/optical-bindings";
import type { EmitterData, FixtureInstance } from "../../model/types";
import { beamConeAngleDegrees } from "../effects/beam-zoom";
import { VISIBLE_INTENSITY_THRESHOLD } from "../emitter-radiance";

/** Moving head constants */
const HEAD_OFFSET_Y = 0.32;

/** Default pan/tilt ranges in degrees */
const DEFAULT_PAN_RANGE = 540;
const DEFAULT_TILT_RANGE = 270;

/** Default beam specification */
const DEFAULT_BEAM_ANGLE = 15;
const DEFAULT_FIELD_ANGLE = 30;
const DEFAULT_LUMENS = 10000;

/** Default pan/tilt movement speed in degrees per second */
const DEFAULT_PAN_SPEED_DEG_PER_SEC = 180;
const DEFAULT_TILT_SPEED_DEG_PER_SEC = 180;

/**
 * Moving head specific data stored on the fixture instance.
 */
export interface MovingHeadData {
  type: "moving-head";
  /** Yoke group that rotates for pan */
  yokeGroup: Group;
  /** Head group that rotates for tilt */
  headGroup: Group;
  /** Current pan angle (radians) - smoothed toward target */
  currentPan: number;
  /** Current tilt angle (radians) - smoothed toward target */
  currentTilt: number;
  /** Target pan angle (radians) from DMX */
  targetPan: number;
  /** Target tilt angle (radians) from DMX */
  targetTilt: number;
  /** Last update timestamp (ms) for smoothing calculation */
  lastUpdateTime: number;
  /** Pan movement speed in degrees per second */
  panSpeedDegPerSec: number;
  /** Tilt movement speed in degrees per second */
  tiltSpeedDegPerSec: number;
  /** Pan range in degrees */
  panRangeDeg: number;
  /** Tilt range in degrees */
  tiltRangeDeg: number;
  /** Beam angle in degrees */
  beamAngleDeg: number;
  /** Field angle in degrees */
  fieldAngleDeg: number;
  /** Element label for DMX lookup (first element) */
  elementLabel: string;
}

type MovingHeadElementDmx = {
  red: number;
  green: number;
  blue: number;
  intensity: number;
  tilt?: number;
  pan?: number;
  zoom?: number;
  /** Full beam angle when the zoom channel carries degree metadata. */
  zoomDegrees?: number;
  frost?: number;
  "Color Wheel"?: number;
};

type BeamRgb = {
  red: number;
  green: number;
  blue: number;
};

type ResolvedBeamColor = {
  primary: BeamRgb;
  secondary?: BeamRgb;
};

/** Minimum RGB output considered a deliberate additive color. */
const MIN_COLOR_OUTPUT = 0.001;

/** Resolve the visible beam color for a moving-head element. */
function resolveMovingHeadBeamColor(
  dmx: MovingHeadElementDmx,
): ResolvedBeamColor {
  if (
    dmx.red > MIN_COLOR_OUTPUT ||
    dmx.green > MIN_COLOR_OUTPUT ||
    dmx.blue > MIN_COLOR_OUTPUT
  ) {
    return { primary: { red: dmx.red, green: dmx.green, blue: dmx.blue } };
  }

  const colorWheelColor = resolveSpotColorWheel(dmx["Color Wheel"]);
  if (colorWheelColor) {
    return colorWheelColor;
  }

  if (dmx.intensity > VISIBLE_INTENSITY_THRESHOLD) {
    return { primary: { red: 1, green: 1, blue: 1 } };
  }

  return { primary: { red: 0, green: 0, blue: 0 } };
}

/** Wraps a single RGB value as a solid beam color. */
function solidBeamColor(primary: BeamRgb): ResolvedBeamColor {
  return { primary };
}

/** Wraps two RGB values as a split-color beam wheel position. */
function splitBeamColor(
  primary: BeamRgb,
  secondary: BeamRgb,
): ResolvedBeamColor {
  return { primary, secondary };
}

/** Approximate the Generic 16-channel spot color wheel as solid or split RGB. */
function resolveSpotColorWheel(
  normalizedColorWheel: number | undefined,
): ResolvedBeamColor | undefined {
  if (normalizedColorWheel === undefined) return undefined;

  const colorWheelValue = Math.round(
    MathUtils.clamp(normalizedColorWheel, 0, 1) * 255,
  );
  const white = { red: 1, green: 1, blue: 1 };
  const red = { red: 1, green: 0, blue: 0 };
  const yellow = { red: 1, green: 1, blue: 0 };
  const blue = { red: 0, green: 0, blue: 1 };
  const green = { red: 0, green: 1, blue: 0 };
  const orange = { red: 1, green: 0.45, blue: 0 };
  const pink = { red: 1, green: 0.35, blue: 0.65 };
  const purple = { red: 0.45, green: 0, blue: 1 };
  const cyan = { red: 0, green: 1, blue: 1 };
  const warmWhite = { red: 1, green: 0.92, blue: 0.72 };
  const lime = { red: 0.65, green: 1, blue: 0.35 };

  if (
    colorWheelValue <= 7 ||
    (colorWheelValue >= 88 && colorWheelValue <= 95)
  ) {
    return solidBeamColor(white);
  }
  if (colorWheelValue <= 16) return solidBeamColor(red);
  if (colorWheelValue <= 23) return solidBeamColor(yellow);
  if (colorWheelValue <= 31) return solidBeamColor(blue);
  if (colorWheelValue <= 39) return solidBeamColor(green);
  if (colorWheelValue <= 47) return solidBeamColor(orange);
  if (colorWheelValue <= 55) return solidBeamColor(pink);
  if (colorWheelValue <= 63) return solidBeamColor(purple);
  if (colorWheelValue <= 71) return solidBeamColor(cyan);
  if (colorWheelValue <= 79) return solidBeamColor(warmWhite);
  if (colorWheelValue <= 87) return solidBeamColor(lime);
  if (colorWheelValue <= 103) return splitBeamColor(white, green);
  if (colorWheelValue <= 111) return splitBeamColor(green, warmWhite);
  if (colorWheelValue <= 119) return splitBeamColor(warmWhite, blue);
  if (colorWheelValue <= 127) return splitBeamColor(blue, pink);
  if (colorWheelValue <= 135) return splitBeamColor(pink, purple);
  if (colorWheelValue <= 143) return splitBeamColor(purple, orange);
  if (colorWheelValue <= 151) return splitBeamColor(orange, yellow);
  if (colorWheelValue <= 159) return splitBeamColor(blue, green);
  if (colorWheelValue <= 167) return splitBeamColor(red, cyan);
  if (colorWheelValue <= 175) return splitBeamColor(red, yellow);

  return solidBeamColor(white);
}

/**
 * Build a moving head fixture.
 * Creates a hardcoded moving head layout with yoke/head/beam hierarchy.
 */
export function buildMovingHeadFixture(
  fixtureUid: string,
  elements: FixtureElement[],
  geometry?: FixtureGeometry,
  physical?: FixturePhysical,
): FixtureInstance & { movingHeadData: MovingHeadData } {
  const group = new Group();
  group.name = `Fixture_${fixtureUid}`;

  // Default to a hanging mount so zero pan/tilt matches the GDTF-style
  // suspended straight-down pose.

  // Create base (static)
  const baseGeometry = new BoxGeometry(0.25, 0.08, 0.25);
  const baseMaterial = new MeshStandardMaterial({
    color: 0x2a2a2a,
    metalness: 0.7,
    roughness: 0.3,
  });
  const base = new Mesh(baseGeometry, baseMaterial);
  base.name = "Base";
  base.position.y = -0.04;
  group.add(base);

  // Create yoke (rotates for pan)
  const yokeGroup = new Group();
  yokeGroup.name = "Yoke";
  yokeGroup.position.y = -0.08;
  group.add(yokeGroup);

  // Yoke arms
  const armGeometry = new BoxGeometry(0.04, 0.25, 0.04);
  const armMaterial = new MeshStandardMaterial({
    color: 0x333333,
    metalness: 0.7,
    roughness: 0.3,
  });
  const leftArm = new Mesh(armGeometry, armMaterial);
  leftArm.name = "LeftArm";
  leftArm.position.set(-0.1, -0.125, 0);
  yokeGroup.add(leftArm);

  const rightArm = new Mesh(armGeometry, armMaterial.clone());
  rightArm.name = "RightArm";
  rightArm.position.set(0.1, -0.125, 0);
  yokeGroup.add(rightArm);

  // Create head group (rotates for tilt)
  const headGroup = new Group();
  headGroup.name = "Head";
  headGroup.position.y = -HEAD_OFFSET_Y;
  yokeGroup.add(headGroup);

  // Head body
  const headGeometry = new BoxGeometry(0.16, 0.2, 0.16);
  const headMaterial = new MeshStandardMaterial({
    color: 0x222222,
    metalness: 0.6,
    roughness: 0.4,
  });
  const head = new Mesh(headGeometry, headMaterial);
  head.name = "HeadBody";
  headGroup.add(head);

  // Lens indicator
  const lensGeometry = new BoxGeometry(0.12, 0.02, 0.12);
  const lensMaterial = new MeshBasicMaterial({ color: 0x444444 });
  const lens = new Mesh(lensGeometry, lensMaterial);
  lens.name = "Lens";
  lens.position.y = -0.11;
  headGroup.add(lens);

  const sourceNode = geometry?.nodes.find((node) => node.beam);
  const source = sourceNode?.beam?.physical ?? physical;
  const beamAngleDeg = source?.beamAngle ?? DEFAULT_BEAM_ANGLE;
  const fieldAngleDeg = source?.fieldAngle ?? DEFAULT_FIELD_ANGLE;
  const lumens = source?.lumens ?? DEFAULT_LUMENS;

  // Get element label from first element (moving heads typically have one main element)
  const elementLabel = elements[0]?.label ?? "Main";

  // Create emitter map for compatibility
  const emitters = new Map<string, EmitterData>();
  const aperture = new Object3D();
  aperture.name = "OpticalAperture";
  aperture.position.copy(lens.position);
  aperture.rotation.x = -Math.PI / 2;
  headGroup.add(aperture);
  emitters.set("MainEmitter", {
    mesh: lens,
    controlledElement: elementLabel,
    nodeGroup: aperture,
    opticalChannels:
      geometry && sourceNode
        ? bindEmitterOpticalChannels(geometry).get(sourceNode.name)
        : undefined,
    opticalWheels: geometry?.opticalWheels,
    gdtfPath: geometry?.gdtfPath,
    optics: sourceNode?.beam ?? {
      physical: source ?? {
        beamType: BeamType.Spot,
        beamAngle: beamAngleDeg,
        fieldAngle: fieldAngleDeg,
        lumens,
        colorTemperature: 6500,
      },
      radius: 0.06,
      throwRatio: 1,
      rectangleRatio: 1,
    },
    beamColor: { red: 0, green: 0, blue: 0, intensity: 0 },
  });

  return {
    uid: fixtureUid,
    group,
    nodeObjects: new Map<string, Object3D>([
      ["Base", base],
      ["Yoke", yokeGroup],
      ["Head", headGroup],
    ]),
    emitters,
    movingHeadData: {
      type: "moving-head",
      yokeGroup,
      headGroup,
      currentPan: 0,
      currentTilt: 0,
      targetPan: 0,
      targetTilt: 0,
      lastUpdateTime: 0,
      panSpeedDegPerSec: DEFAULT_PAN_SPEED_DEG_PER_SEC,
      tiltSpeedDegPerSec: DEFAULT_TILT_SPEED_DEG_PER_SEC,
      panRangeDeg: DEFAULT_PAN_RANGE,
      tiltRangeDeg: DEFAULT_TILT_RANGE,
      beamAngleDeg,
      fieldAngleDeg,
      elementLabel,
    },
  };
}

/**
 * Update moving head colors and positioning from DMX data.
 * Uses time-based smoothing for realistic pan/tilt movement.
 *
 * @param elementColors Map with element labels as keys
 *   Expected to contain pan/tilt values normalized for this renderer's rotation range,
 *   with 0 representing the hanging straight-down pose.
 */
export function updateMovingHeadColors(
  instance: FixtureInstance & { movingHeadData: MovingHeadData },
  elementColors: Map<string, MovingHeadElementDmx>,
): void {
  const data = instance.movingHeadData;

  // Get DMX values from first element using stored label
  const dmx = elementColors.get(data.elementLabel);
  if (!dmx) return;

  // Extract values with defaults
  const pan = dmx.pan ?? 0;
  const tilt = dmx.tilt ?? 0;
  const frost = dmx.frost ?? 0;
  const intensity = dmx.intensity;
  const beamColor = resolveMovingHeadBeamColor(dmx);

  // Calculate time delta for smoothing
  const now = performance.now();
  const deltaMs = data.lastUpdateTime === 0 ? 0 : now - data.lastUpdateTime;
  const deltaSeconds = deltaMs / 1000;
  data.lastUpdateTime = now;

  const panDegrees = pan * data.panRangeDeg;
  const targetPanAngle = MathUtils.degToRad(panDegrees);
  data.targetPan = targetPanAngle;

  const tiltDegrees = tilt * data.tiltRangeDeg;
  const targetTiltAngle = MathUtils.degToRad(tiltDegrees);
  data.targetTilt = targetTiltAngle;

  // Apply smoothing - move current toward target at max speed
  if (deltaSeconds > 0) {
    // Pan smoothing
    const maxPanStep = MathUtils.degToRad(
      data.panSpeedDegPerSec * deltaSeconds,
    );
    const panDelta = targetPanAngle - data.currentPan;
    const clampedPanDelta = MathUtils.clamp(panDelta, -maxPanStep, maxPanStep);
    data.currentPan += clampedPanDelta;

    // Tilt smoothing
    const maxTiltStep = MathUtils.degToRad(
      data.tiltSpeedDegPerSec * deltaSeconds,
    );
    const tiltDelta = targetTiltAngle - data.currentTilt;
    const clampedTiltDelta = MathUtils.clamp(
      tiltDelta,
      -maxTiltStep,
      maxTiltStep,
    );
    data.currentTilt += clampedTiltDelta;
  } else {
    // First frame - snap to position
    data.currentPan = targetPanAngle;
    data.currentTilt = targetTiltAngle;
  }

  // Apply rotation to groups
  data.yokeGroup.rotation.y = data.currentPan;
  data.headGroup.rotation.x = data.currentTilt;

  const coneAngleDeg =
    dmx.zoomDegrees ??
    beamConeAngleDegrees(data.beamAngleDeg, data.fieldAngleDeg, dmx.zoom);

  const color = new Color(
    beamColor.primary.red,
    beamColor.primary.green,
    beamColor.primary.blue,
  );
  color.convertSRGBToLinear();
  const secondaryColor = new Color(
    beamColor.secondary?.red ?? beamColor.primary.red,
    beamColor.secondary?.green ?? beamColor.primary.green,
    beamColor.secondary?.blue ?? beamColor.primary.blue,
  );
  secondaryColor.convertSRGBToLinear();
  const opticalColor = instance.emitters.get("MainEmitter")!.beamColor!;
  opticalColor.red = color.r;
  opticalColor.green = color.g;
  opticalColor.blue = color.b;
  opticalColor.intensity = intensity;
  opticalColor.zoomDegrees = coneAngleDeg;
  opticalColor.frost = frost;
  opticalColor.secondaryRed = beamColor.secondary
    ? secondaryColor.r
    : undefined;
  opticalColor.secondaryGreen = beamColor.secondary
    ? secondaryColor.g
    : undefined;
  opticalColor.secondaryBlue = beamColor.secondary
    ? secondaryColor.b
    : undefined;

  // Update lens emissive color
  const isVisible = intensity > VISIBLE_INTENSITY_THRESHOLD;
  const lensMaterial = (instance.emitters.get("MainEmitter")?.mesh as Mesh)
    ?.material;
  if (lensMaterial instanceof MeshBasicMaterial) {
    if (isVisible) {
      lensMaterial.color.setRGB(
        color.r * intensity * 2,
        color.g * intensity * 2,
        color.b * intensity * 2,
      );
    } else {
      lensMaterial.color.setRGB(0.27, 0.27, 0.27);
    }
  }
}

/**
 * Dispose moving head resources.
 */
export function disposeMovingHead(
  instance: FixtureInstance & { movingHeadData: MovingHeadData },
): void {
  instance.group.traverse((child) => {
    if (child instanceof Mesh) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        for (const mat of child.material) {
          mat.dispose();
        }
      } else if (child.material) {
        child.material.dispose();
      }
    }
  });
}
