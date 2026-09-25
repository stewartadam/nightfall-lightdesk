// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Generic 12-pixel rotating wash beam renderer for Visualizer.
 * Renders a manually modeled linear beam fixture with 12 wash apertures and
 * two decorative 12-pixel LED strips.
 */

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from "three/webgpu";
import {
  BeamType,
  type FixtureElement,
  type FixturePhysical,
} from "../../../../types";
import type { EmitterData, FixtureInstance } from "../../model/types";
import { beamConeAngleDegrees } from "../effects/beam-zoom";
import {
  createEmitterBatches,
  type EmitterBatch,
  updateEmitterBatches,
} from "./emitter-batches";

const BEAM_COUNT = 12;
const STRIP_PIXEL_COUNT = 12;
const STRIP_COUNT = 2;
const CONTROL_ELEMENT_INDEX = 0;
const BEAM_ELEMENT_OFFSET = 1;
const STRIP_ELEMENT_OFFSET = BEAM_ELEMENT_OFFSET + BEAM_COUNT;
const INCH_TO_METER = 0.0254;

const TOTAL_WIDTH = 1.0;
const TOTAL_HEIGHT = 15 * INCH_TO_METER;
const FIXTURE_WIDTH = 0.922;
const FIXTURE_HEIGHT = 0.215;
const FIXTURE_DEPTH = 0.267;
const FACE_Z = FIXTURE_DEPTH / 2 + 0.006;
const BASE_WIDTH = TOTAL_WIDTH;
const BASE_HEIGHT = 0.055;
const BASE_DEPTH = 0.23;
const BASE_Y = FIXTURE_HEIGHT / 2 - TOTAL_HEIGHT + BASE_HEIGHT / 2;
const BASE_Z = 0;
const PIVOT_Z = 0;
const PIVOT_SUPPORT_WIDTH = 0.08;
const PIVOT_SUPPORT_HEIGHT = TOTAL_HEIGHT - FIXTURE_HEIGHT / 2;
const PIVOT_SUPPORT_DEPTH = 0.15;
const PIVOT_SUPPORT_CENTER_Y = -PIVOT_SUPPORT_HEIGHT / 2;
const LENS_RADIUS = 0.034;
const LENS_DEPTH = 0.018;
const STRIP_PIXEL_WIDTH = 0.052;
const STRIP_PIXEL_HEIGHT = 0.026;
const STRIP_TOP_Y = 0.08;
const STRIP_BOTTOM_Y = -0.08;
const DEFAULT_BEAM_ANGLE = 6;
const DEFAULT_FIELD_ANGLE = 28;
const TILT_RANGE_DEGREES = 270;
const TILT_UP_REFERENCE_DEGREES = -90;
const DEFAULT_TILT_SPEED_DEG_PER_SEC = 180;
const MAX_TILT_SPEED_DEG_PER_SEC = 720;
const BEAM_COLOR = new Color();
const FLAT_EMITTER_COLOR = new Color();

interface EmitterColorData {
  red: number;
  green: number;
  blue: number;
  intensity: number;
  tilt?: number;
  tiltSpeed?: number;
  zoom?: number;
  /** Full beam angle when the zoom channel carries degree metadata. */
  zoomDegrees?: number;
  frost?: number;
}

interface WashBeamEmitterData {
  optical: EmitterData;
  lensMesh: Mesh;
  beamNode: Group;
  elementLabel: string;
}

/**
 * Renderer state for the Generic 12-pixel rotating wash beam fixture.
 */
export interface RotatingWashBeamData {
  type: "rotating-wash-beam";
  tiltGroup: Group;
  beamEmitters: WashBeamEmitterData[];
  stripPixelMeshes: Mesh[];
  emitterBatches: EmitterBatch[];
  controlElementLabel?: string;
  beamElementLabels: string[];
  stripElementLabels: string[];
  elementLabels: string[];
  currentTilt: number;
  targetTilt: number;
  lastUpdateTime: number;
}

/**
 * Build a Generic 12-pixel rotating wash beam fixture from element metadata.
 */
export function buildRotatingWashBeamFixture(
  fixtureUid: string,
  elements: FixtureElement[],
  beamCount = BEAM_COUNT,
  physical?: FixturePhysical,
): FixtureInstance & { rotatingWashBeamData: RotatingWashBeamData } {
  const group = new Group();
  group.name = `Fixture_${fixtureUid}`;

  const tiltGroup = new Group();
  tiltGroup.name = "TiltHead";
  group.add(tiltGroup);

  const base = createBaseGroup();
  group.add(base);

  const housing = createHousingMesh();
  tiltGroup.add(housing);

  const endCapMaterial = new MeshStandardMaterial({
    color: 0x101010,
    metalness: 0.7,
    roughness: 0.35,
  });
  for (const x of [-FIXTURE_WIDTH / 2 - 0.035, FIXTURE_WIDTH / 2 + 0.035]) {
    const endCap = new Mesh(
      new BoxGeometry(0.05, FIXTURE_HEIGHT * 0.9, FIXTURE_DEPTH * 1.1),
      endCapMaterial.clone(),
    );
    endCap.name = "EndCap";
    endCap.position.x = x;
    tiltGroup.add(endCap);
  }

  const elementLabels = elements.map((element) => element.label);
  const controlElementLabel = elementLabels[CONTROL_ELEMENT_INDEX];
  const beamElementLabels = elementLabels.slice(
    BEAM_ELEMENT_OFFSET,
    BEAM_ELEMENT_OFFSET + beamCount,
  );
  const stripElementLabels = elementLabels.slice(
    STRIP_ELEMENT_OFFSET,
    STRIP_ELEMENT_OFFSET + STRIP_PIXEL_COUNT * STRIP_COUNT,
  );
  const emitters = new Map<string, EmitterData>();
  const beamEmitters: WashBeamEmitterData[] = [];
  const stripPixelMeshes: Mesh[] = [];

  for (let index = 0; index < beamCount; index++) {
    const x = beamX(index, beamCount);
    const beamNode = new Group();
    beamNode.name = `BeamNode_${index + 1}`;
    beamNode.position.set(x, 0, FACE_Z);
    beamNode.rotation.x = -Math.PI / 2;
    tiltGroup.add(beamNode);

    const lensMesh = createLensMesh(index + 1);
    lensMesh.position.set(x, 0, FACE_Z);
    tiltGroup.add(lensMesh);

    const elementLabel = beamElementLabels[index] ?? `Beam ${index + 1}`;
    const aperture = new Object3D();
    aperture.name = `OpticalAperture_${index}`;
    aperture.rotation.x = -Math.PI / 2;
    beamNode.add(aperture);
    const optical: EmitterData = {
      mesh: lensMesh,
      controlledElement: elementLabel,
      nodeGroup: aperture,
      optics: {
        physical: physical
          ? {
              ...physical,
              lumens:
                physical.lumens === undefined
                  ? undefined
                  : physical.lumens / beamCount,
            }
          : {
              beamType: BeamType.Wash,
              beamAngle: DEFAULT_BEAM_ANGLE,
              fieldAngle: DEFAULT_BEAM_ANGLE + DEFAULT_FIELD_ANGLE,
            },
        radius: LENS_RADIUS,
        throwRatio: 1,
        rectangleRatio: 1,
      },
      beamColor: { red: 0, green: 0, blue: 0, intensity: 0 },
    };
    beamEmitters.push({
      optical,
      lensMesh,
      beamNode,
      elementLabel,
    });
    emitters.set(`Beam_${index}`, optical);
  }

  for (
    let stripIndex = 0;
    stripIndex < (beamCount === BEAM_COUNT ? STRIP_COUNT : 0);
    stripIndex++
  ) {
    const y = stripIndex === 0 ? STRIP_TOP_Y : STRIP_BOTTOM_Y;
    const stripName = stripIndex === 0 ? "TopStrip" : "BottomStrip";
    for (let pixelIndex = 0; pixelIndex < STRIP_PIXEL_COUNT; pixelIndex++) {
      const mesh = createStripPixelMesh(stripName, pixelIndex + 1);
      mesh.position.set(beamX(pixelIndex), y, FACE_Z + 0.006);
      tiltGroup.add(mesh);
      stripPixelMeshes.push(mesh);

      const elementLabel =
        stripElementLabels[stripIndex * STRIP_PIXEL_COUNT + pixelIndex] ??
        `${stripName} Pixel ${pixelIndex + 1}`;
      emitters.set(`${stripName}_${pixelIndex}`, {
        mesh,
        controlledElement: elementLabel,
      });
    }
  }

  const emitterBatches = createEmitterBatches(tiltGroup, [
    beamEmitters.map((beam) => beam.lensMesh),
    stripPixelMeshes,
  ]);
  emitterBatches.forEach(({ mesh }, index) => {
    mesh.name = `WashEmitterInstances_${index}`;
  });
  return {
    uid: fixtureUid,
    group,
    nodeObjects: new Map<string, Object3D>([
      ["Base", base],
      ["Housing", housing],
      ["TiltHead", tiltGroup],
    ]),
    emitters,
    rotatingWashBeamData: {
      type: "rotating-wash-beam",
      tiltGroup,
      beamEmitters,
      stripPixelMeshes,
      emitterBatches,
      controlElementLabel,
      beamElementLabels,
      stripElementLabels,
      elementLabels,
      currentTilt: MathUtils.degToRad(TILT_UP_REFERENCE_DEGREES),
      targetTilt: MathUtils.degToRad(TILT_UP_REFERENCE_DEGREES),
      lastUpdateTime: 0,
    },
  };
}

/**
 * Update Generic wash beam lenses, strip pixels, and aperture optical state from visualizer DMX data.
 */
export function updateRotatingWashBeamColors(
  instance: FixtureInstance & { rotatingWashBeamData: RotatingWashBeamData },
  elementColors: Map<string, EmitterColorData>,
): void {
  const data = instance.rotatingWashBeamData;
  const control = colorForElement(
    elementColors,
    CONTROL_ELEMENT_INDEX,
    data.controlElementLabel,
  );
  const masterIntensity = control?.intensity ?? 1;
  const zoom = control?.zoom ?? 0.5;
  const zoomDegrees = control?.zoomDegrees;
  const frost = control?.frost ?? 0;
  const tilt = control?.tilt ?? 0;
  const tiltSpeed = control?.tiltSpeed;
  data.targetTilt = MathUtils.degToRad(
    TILT_UP_REFERENCE_DEGREES + tilt * TILT_RANGE_DEGREES,
  );
  const now = performance.now();
  const deltaSeconds =
    data.lastUpdateTime === 0
      ? 0
      : Math.max(0, (now - data.lastUpdateTime) / 1000);
  data.lastUpdateTime = now;

  if (deltaSeconds > 0) {
    const speed =
      tiltSpeed === undefined
        ? DEFAULT_TILT_SPEED_DEG_PER_SEC
        : MathUtils.lerp(
            DEFAULT_TILT_SPEED_DEG_PER_SEC,
            MAX_TILT_SPEED_DEG_PER_SEC,
            MathUtils.clamp(tiltSpeed, 0, 1),
          );
    const maxStep = MathUtils.degToRad(speed * deltaSeconds);
    const tiltDelta = data.targetTilt - data.currentTilt;
    data.currentTilt += MathUtils.clamp(tiltDelta, -maxStep, maxStep);
  } else {
    data.currentTilt = data.targetTilt;
  }

  data.tiltGroup.rotation.x = data.currentTilt;
  data.tiltGroup.updateMatrixWorld(true);

  for (let index = 0; index < data.beamEmitters.length; index++) {
    const beam = data.beamEmitters[index];
    const color = colorForElement(
      elementColors,
      BEAM_ELEMENT_OFFSET + index,
      beam.elementLabel,
    );
    updateBeamEmitter(beam, color, masterIntensity, zoom, zoomDegrees, frost);
  }

  for (let index = 0; index < data.stripPixelMeshes.length; index++) {
    const mesh = data.stripPixelMeshes[index];
    const color = colorForElement(
      elementColors,
      STRIP_ELEMENT_OFFSET + index,
      data.stripElementLabels[index],
    );
    updateFlatEmitter(mesh, color, 1);
  }
  updateEmitterBatches(data);
}

/**
 * Dispose geometry and materials held by a Generic wash beam fixture instance.
 */
export function disposeRotatingWashBeam(
  instance: FixtureInstance & { rotatingWashBeamData: RotatingWashBeamData },
): void {
  for (const { mesh } of instance.rotatingWashBeamData.emitterBatches)
    mesh.dispose();
  instance.group.traverse((object) => {
    if (object instanceof Mesh) {
      object.geometry.dispose();
      if (Array.isArray(object.material)) {
        for (const material of object.material) {
          material.dispose();
        }
      } else {
        object.material.dispose();
      }
    }
  });
}

/**
 * Create the main metal body for the scanned wash beam shape.
 */
function createHousingMesh(): Mesh {
  const geometry = new BoxGeometry(
    FIXTURE_WIDTH,
    FIXTURE_HEIGHT,
    FIXTURE_DEPTH,
  );
  const material = new MeshStandardMaterial({
    color: 0x151515,
    metalness: 0.65,
    roughness: 0.42,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = "Housing";
  return mesh;
}

/**
 * Create the fixed base and side supports that carry the rotating head.
 */
function createBaseGroup(): Group {
  const group = new Group();
  group.name = "Base";

  const baseMaterial = new MeshStandardMaterial({
    color: 0x0e0e0e,
    metalness: 0.72,
    roughness: 0.38,
  });
  const supportMaterial = new MeshStandardMaterial({
    color: 0x121212,
    metalness: 0.68,
    roughness: 0.36,
  });

  const rail = new Mesh(
    new BoxGeometry(BASE_WIDTH, BASE_HEIGHT, BASE_DEPTH),
    baseMaterial,
  );
  rail.name = "BaseRail";
  rail.position.set(0, BASE_Y, BASE_Z);
  group.add(rail);

  for (const side of [-1, 1]) {
    const support = new Mesh(
      new BoxGeometry(
        PIVOT_SUPPORT_WIDTH,
        PIVOT_SUPPORT_HEIGHT,
        PIVOT_SUPPORT_DEPTH,
      ),
      supportMaterial.clone(),
    );
    support.name = side < 0 ? "LeftPivotSupport" : "RightPivotSupport";
    support.position.set(
      side * (TOTAL_WIDTH / 2 - PIVOT_SUPPORT_WIDTH / 2),
      PIVOT_SUPPORT_CENTER_Y,
      PIVOT_Z,
    );
    group.add(support);

    const pivotBoss = new Mesh(
      new CylinderGeometry(0.095, 0.095, PIVOT_SUPPORT_WIDTH + 0.01, 32),
      supportMaterial.clone(),
    );
    pivotBoss.name = side < 0 ? "LeftPivotBoss" : "RightPivotBoss";
    pivotBoss.rotation.z = Math.PI / 2;
    pivotBoss.position.set(
      side * (TOTAL_WIDTH / 2 - PIVOT_SUPPORT_WIDTH / 2),
      0,
      PIVOT_Z,
    );
    group.add(pivotBoss);
  }

  return group;
}

/**
 * Create one round beam aperture lens.
 */
function createLensMesh(index: number): Mesh {
  const geometry = new CylinderGeometry(
    LENS_RADIUS,
    LENS_RADIUS,
    LENS_DEPTH,
    40,
  );
  const material = new MeshBasicMaterial({ color: 0x252525 });
  const mesh = new Mesh(geometry, material);
  mesh.name = `Lens_${index}`;
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

/**
 * Create one decorative strip pixel lens.
 */
function createStripPixelMesh(stripName: string, pixelIndex: number): Mesh {
  const geometry = new BoxGeometry(
    STRIP_PIXEL_WIDTH,
    STRIP_PIXEL_HEIGHT,
    0.014,
  );
  const material = new MeshBasicMaterial({ color: 0x000000 });
  const mesh = new Mesh(geometry, material);
  mesh.name = `${stripName}Pixel_${pixelIndex}`;
  return mesh;
}

/**
 * Resolve an element color by update path key, accepting both index and label keys.
 */
function colorForElement(
  elementColors: Map<string, EmitterColorData>,
  elementIndex: number,
  elementLabel: string | undefined,
): EmitterColorData | undefined {
  return (
    elementColors.get(String(elementIndex)) ??
    (elementLabel ? elementColors.get(elementLabel) : undefined)
  );
}

/**
 * Compute the left-to-right beam and strip pixel X coordinate.
 */
function beamX(index: number, count = BEAM_COUNT): number {
  const spacing = FIXTURE_WIDTH / count;
  return -FIXTURE_WIDTH / 2 + spacing / 2 + index * spacing;
}

/**
 * Update one beam's lens and the optical state its aperture publishes to the shared batch.
 *
 * The cone uses the control channel's degree-valued zoom when present, falling
 * back to interpolating the beam and field angles by normalized zoom.
 */
function updateBeamEmitter(
  beam: WashBeamEmitterData,
  colorData: EmitterColorData | undefined,
  masterIntensity: number,
  zoom: number,
  zoomDegrees: number | undefined,
  frost: number,
): void {
  const intensity = (colorData?.intensity ?? 0) * masterIntensity;
  updateFlatEmitter(beam.lensMesh, colorData, masterIntensity);

  const coneAngleDeg =
    zoomDegrees ??
    beamConeAngleDegrees(
      beam.optical.optics!.physical.beamAngle,
      beam.optical.optics!.physical.fieldAngle,
      zoom,
    );
  const color = BEAM_COLOR.setRGB(
    colorData?.red ?? 0,
    colorData?.green ?? 0,
    colorData?.blue ?? 0,
  );
  color.convertSRGBToLinear();
  const opticalColor = beam.optical.beamColor!;
  opticalColor.red = color.r;
  opticalColor.green = color.g;
  opticalColor.blue = color.b;
  opticalColor.intensity = intensity;
  opticalColor.zoomDegrees = coneAngleDeg;
  opticalColor.frost = frost;
}

/**
 * Update a flat emissive lens or decorative strip pixel.
 */
function updateFlatEmitter(
  mesh: Mesh,
  colorData: EmitterColorData | undefined,
  masterIntensity: number,
): void {
  const material = mesh.material as MeshBasicMaterial;
  if (!colorData) {
    material.color.setRGB(0, 0, 0);
    return;
  }

  const color = FLAT_EMITTER_COLOR.setRGB(
    colorData.red,
    colorData.green,
    colorData.blue,
  ).convertSRGBToLinear();
  material.color.copy(
    color.multiplyScalar(
      Math.min(2.0, colorData.intensity * masterIntensity * 2),
    ),
  );
}
