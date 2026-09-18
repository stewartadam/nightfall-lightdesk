// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Moving head fixture renderer for Visualizer.
 * Renders moving head fixtures with pan/tilt movement and volumetric beam.
 *
 * Moving heads have:
 * - A base (static, pan rotation)
 * - A yoke (rotates for pan)
 * - A head (rotates for tilt, contains the light source)
 * - A volumetric light beam
 */

import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SpotLight,
  Vector3,
} from "three/webgpu";
import type { VisualizerBeamQuality } from "../../../../lib/feature-flags";
import type { FixtureElement, FixtureGeometry } from "../../../../types";
import type { EmitterData, FixtureInstance } from "../../model/types";
import {
  type BeamMaterial,
  type BeamParameters,
  createBeamGeometry,
  createBeamMaterial,
  defaultBeamParameters,
  disposeBeamMaterial,
  isLowQualityBeamMaterial,
  MAX_CONE_ANGLE_DEGREES,
  MIN_CONE_ANGLE_DEGREES,
  updateBeamMaterial,
} from "../effects/beam-material";
import { beamConeAngleDegrees } from "../effects/beam-zoom";
import { DEFAULT_STAGE_FLOOR_TOP_Y } from "../scene-environment";

/** Moving head constants */
const MAX_BEAM_LENGTH = 50.0;
const MIN_BEAM_RADIUS = 0.04;
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
const WORLD_UP = new Vector3(0, 1, 0);
const WORLD_RIGHT = new Vector3(1, 0, 0);
const FLOOR_SPOT_FLOOR_QUATERNION = new Quaternion().setFromAxisAngle(
  WORLD_RIGHT,
  -Math.PI / 2,
);
const FLOOR_SPOT_PARENT_QUATERNION = new Quaternion();
const FLOOR_SPOT_YAW_QUATERNION = new Quaternion();
const FLOOR_SPOT_WORLD_QUATERNION = new Quaternion();

/**
 * Moving head specific data stored on the fixture instance.
 */
export interface MovingHeadData {
  type: "moving-head";
  /** Yoke group that rotates for pan */
  yokeGroup: Group;
  /** Head group that rotates for tilt */
  headGroup: Group;
  /** Beam mesh */
  beamMesh: Mesh;
  /** Beam material with uniforms */
  beamMaterial: BeamMaterial;
  /** Floor illumination mesh */
  floorSpotMesh: Mesh;
  /** SpotLight for ground illumination */
  spotLight: SpotLight;
  /** SpotLight target */
  spotlightTarget: Object3D;
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
  /** Fixture lumens */
  lumens: number;
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

  if (dmx.intensity > 0.01) {
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
  beamQuality: VisualizerBeamQuality = "high",
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

  // Create beam material and geometry
  const beamMaterial = createBeamMaterial(beamQuality);
  const beamGeometryMesh = createBeamGeometry(beamQuality);

  // Beam mesh - unit cone that gets scaled dynamically
  const beamMesh = new Mesh(beamGeometryMesh, beamMaterial);
  beamMesh.name = "Beam";
  beamMesh.position.set(0, -0.5, 0);
  beamMesh.castShadow = false;
  beamMesh.frustumCulled = false;
  beamMesh.renderOrder = 100;
  beamMesh.visible = false; // Start hidden until intensity > 0
  headGroup.add(beamMesh);

  const floorSpotGeometry = new CircleGeometry(1, 64);
  const floorSpotMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
  const floorSpotMesh = new Mesh(floorSpotGeometry, floorSpotMaterial);
  floorSpotMesh.name = "BeamFootprint";
  floorSpotMesh.rotation.x = -Math.PI / 2;
  floorSpotMesh.renderOrder = 101;
  floorSpotMesh.visible = false;
  group.add(floorSpotMesh);

  // Create spotlight for ground illumination
  const spotLight = new SpotLight(0xffffff, 0);
  spotLight.name = "SpotLight";
  spotLight.angle = Math.PI / 12;
  spotLight.penumbra = 0.5;
  spotLight.decay = 2;
  spotLight.distance = 50;
  spotLight.castShadow = false;
  spotLight.visible = false;
  headGroup.add(spotLight);

  // Spotlight target
  const spotlightTarget = new Object3D();
  spotlightTarget.name = "SpotLightTarget";
  spotlightTarget.position.set(0, -10, 0);
  headGroup.add(spotlightTarget);
  spotLight.target = spotlightTarget;

  // Extract beam parameters from GDTF if available
  // TODO: Extract beam specs from fixture physical properties when available
  // For now, use default values. The geometry.nodes don't contain beam info
  // (beam specs are in FixturePhysical, not GeometryNode)
  void geometry;
  const beamAngleDeg = DEFAULT_BEAM_ANGLE;
  const fieldAngleDeg = DEFAULT_FIELD_ANGLE;
  const lumens = DEFAULT_LUMENS;

  // Get element label from first element (moving heads typically have one main element)
  const elementLabel = elements[0]?.label ?? "Main";

  // Create emitter map for compatibility
  const emitters = new Map<string, EmitterData>();
  emitters.set("MainEmitter", {
    mesh: lens,
    controlledElement: elementLabel,
    nodeGroup: headGroup,
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
      beamMesh,
      beamMaterial,
      floorSpotMesh,
      spotLight,
      spotlightTarget,
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
      lumens,
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
  const zoom = dmx.zoom ?? 0.5;
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

  const coneAngleDeg = beamConeAngleDegrees(
    data.beamAngleDeg,
    data.fieldAngleDeg,
    zoom,
  );
  const halfAngleRad = MathUtils.degToRad(coneAngleDeg / 2);

  // Calculate beam origin world position
  const beamOrigin = new Vector3();
  const beamDirection = new Vector3(0, -1, 0);
  const beamQuaternion = new Quaternion();
  data.headGroup.updateMatrixWorld(true);
  data.headGroup.getWorldPosition(beamOrigin);
  data.headGroup.getWorldQuaternion(beamQuaternion);
  beamDirection.applyQuaternion(beamQuaternion).normalize();

  const isLowQuality = isLowQualityBeamMaterial(data.beamMaterial);
  // Keep the full cone length so the low-quality material does not expose the
  // cone cap as a moving floor-intersection shape.
  const beamLength = MAX_BEAM_LENGTH;

  // Cone radius at base
  const baseRadius = Math.max(
    MIN_BEAM_RADIUS,
    beamLength * Math.tan(halfAngleRad),
  );

  // Scale beam mesh: X/Z for radius, Y for length
  data.beamMesh.scale.set(baseRadius, beamLength, baseRadius);
  data.beamMesh.position.set(0, -beamLength / 2, 0);

  // Build beam parameters
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

  const params: BeamParameters = {
    ...defaultBeamParameters,
    intensity,
    color: [color.r, color.g, color.b, 0.6],
    secondaryColor: [secondaryColor.r, secondaryColor.g, secondaryColor.b],
    splitColorAmount: beamColor.secondary ? 1 : 0,
    coneAngleDegrees: Math.max(
      MIN_CONE_ANGLE_DEGREES,
      Math.min(MAX_CONE_ANGLE_DEGREES, coneAngleDeg),
    ),
    beamDirection,
    beamOrigin,
    beamLength,
    clipY: DEFAULT_STAGE_FLOOR_TOP_Y,
    softIntersectionFade: 0.0,
    frostAmount: frost,
  };

  // Update beam material uniforms
  updateBeamMaterial(data.beamMaterial, params);

  // Update spotlight to match beam
  data.spotLight.color.copy(color);
  data.spotLight.intensity = isLowQuality ? 0 : intensity * data.lumens * 0.01;
  data.spotLight.angle = halfAngleRad;
  data.spotLight.distance = MAX_BEAM_LENGTH + 10;
  data.spotlightTarget.position.set(0, -beamLength, 0);

  // Visibility based on intensity
  const isVisible = intensity > 0.01;
  data.beamMesh.visible = isVisible;
  data.spotLight.visible = false;
  updateMovingHeadFloorSpot(
    instance,
    color,
    intensity,
    beamOrigin,
    beamDirection,
    halfAngleRad,
    beamLength,
  );

  // Update lens emissive color
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
 * Updates the synthetic floor illumination for a moving-head beam.
 */
function updateMovingHeadFloorSpot(
  instance: FixtureInstance & { movingHeadData: MovingHeadData },
  color: Color,
  intensity: number,
  beamOrigin: Vector3,
  beamDirection: Vector3,
  halfAngleRad: number,
  beamLength: number,
): void {
  const { floorSpotMesh } = instance.movingHeadData;
  const material = floorSpotMesh.material as MeshBasicMaterial;

  if (intensity <= 0.01 || beamDirection.y >= -0.001) {
    floorSpotMesh.visible = false;
    material.opacity = 0;
    return;
  }

  const distanceToFloor =
    (DEFAULT_STAGE_FLOOR_TOP_Y - beamOrigin.y) / beamDirection.y;
  if (distanceToFloor <= 0 || distanceToFloor > beamLength) {
    floorSpotMesh.visible = false;
    material.opacity = 0;
    return;
  }

  const radius = Math.max(
    MIN_BEAM_RADIUS,
    distanceToFloor * Math.tan(halfAngleRad),
  );
  const incidence = Math.max(Math.abs(beamDirection.y), 0.15);
  const majorRadius = Math.min(radius / incidence, beamLength);

  const worldHit = beamOrigin
    .clone()
    .addScaledVector(beamDirection, distanceToFloor);
  worldHit.y = DEFAULT_STAGE_FLOOR_TOP_Y + 0.003;
  floorSpotMesh.position.copy(instance.group.worldToLocal(worldHit));

  const horizontalDirection = new Vector3(beamDirection.x, 0, beamDirection.z);
  let floorSpotYaw = 0;
  if (horizontalDirection.lengthSq() > 1e-6) {
    horizontalDirection.normalize();
    floorSpotYaw = Math.atan2(-horizontalDirection.z, horizontalDirection.x);
  }

  FLOOR_SPOT_YAW_QUATERNION.setFromAxisAngle(WORLD_UP, floorSpotYaw);
  FLOOR_SPOT_WORLD_QUATERNION.copy(FLOOR_SPOT_YAW_QUATERNION).multiply(
    FLOOR_SPOT_FLOOR_QUATERNION,
  );
  instance.group.getWorldQuaternion(FLOOR_SPOT_PARENT_QUATERNION);
  floorSpotMesh.quaternion
    .copy(FLOOR_SPOT_PARENT_QUATERNION)
    .invert()
    .multiply(FLOOR_SPOT_WORLD_QUATERNION);
  floorSpotMesh.scale.set(majorRadius, radius, 1);
  material.color.copy(color);
  material.opacity = MathUtils.clamp(intensity * 0.35, 0, 0.45);
  floorSpotMesh.visible = true;
}

/**
 * Dispose moving head resources.
 */
export function disposeMovingHead(
  instance: FixtureInstance & { movingHeadData: MovingHeadData },
): void {
  const data = instance.movingHeadData;

  // Dispose beam
  data.beamMesh.geometry?.dispose();
  disposeBeamMaterial(data.beamMaterial);
  data.spotLight.dispose();

  // Dispose meshes in group
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
