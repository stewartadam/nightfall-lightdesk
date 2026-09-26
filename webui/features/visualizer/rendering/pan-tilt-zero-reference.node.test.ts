// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  Group,
  MathUtils,
  type MeshBasicMaterial,
  Quaternion,
  Scene,
  Vector3,
} from "three/webgpu";
import {
  type Attribute,
  AxisType,
  DmxValueResolution,
  type FixtureElement,
  type FixtureGeometry,
  FixtureLayout,
  GeometryType,
  MergeStrategy,
  ParameterValuePolarity,
  type Transform,
} from "../../../types";
import type { RenderableFixture } from "../model/types";
import { isLowQualityBeamMaterial } from "./effects/beam-material";
import { FixtureManager } from "./fixture-manager";
import { buildSimpleLedBar } from "./fixture-renderers/led-bar-renderer";
import {
  buildMovingHeadFixture,
  updateMovingHeadColors,
} from "./fixture-renderers/moving-head-renderer";
import {
  buildFixtureWithRenderer,
  detectRendererType,
} from "./fixture-renderers/renderer-registry";
import {
  buildRotatingWashBeamFixture,
  disposeRotatingWashBeam,
  updateRotatingWashBeamColors,
} from "./fixture-renderers/rotating-wash-beam-renderer";
import {
  buildRgbStrobeBarFixture,
  buildStrobePanelFixture,
  updateStrobePanelColors,
} from "./fixture-renderers/strobe-renderer";
import { createGdtfJoints, updateGdtfJoints } from "./gdtf-joints";
import {
  applyStrobeShutterIntensity,
  extractElementDmxData,
  extractVisualizerDmx,
  fixtureIntensityValueFromOutputs,
  strobeShutterFrequencyHz,
  strobeShutterOutputScale,
} from "./visualizer-dmx";

/**
 * Asserts that numeric values match within the tolerance used by geometry comparisons.
 */
function approx(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

/**
 * Reads a box geometry size so tests can verify rendered zero-reference dimensions.
 */
function boxGeometrySize(mesh: { geometry: unknown }): {
  width: number;
  height: number;
  depth: number;
} {
  const geometry = mesh.geometry as {
    parameters?: { width?: unknown; height?: unknown; depth?: unknown };
  };
  const width = geometry.parameters?.width;
  const height = geometry.parameters?.height;
  const depth = geometry.parameters?.depth;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof depth !== "number"
  ) {
    throw new Error("expected BoxGeometry width, height, and depth parameters");
  }
  return { width, height, depth };
}

/**
 * Builds an identity fixture transform for pan/tilt zero-reference fixtures.
 */
function identityTransform(): Transform {
  return {
    elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
}

/**
 * Builds a minimal geometry payload for renderer-registry selection tests.
 */
function emptyGeometry(): FixtureGeometry {
  return {
    nodes: [],
    roots: [],
  };
}

/**
 * Builds parameter metadata for fixture elements used by zero-reference tests.
 */
function parameter(
  attributeType: Exclude<Attribute["type"], "Custom">,
  max = 255,
): FixtureElement["parameters"][number] {
  return {
    attribute: { type: attributeType },
    is_inverted: false,
    is_snap: false,
    max,
    min: 0,
    merge_type: MergeStrategy.LTP,
    offset: { type: "Absolute", data: { value: 0 } },
    resolution:
      attributeType === "Tilt"
        ? DmxValueResolution.Fine
        : DmxValueResolution.Coarse,
    use_grandmaster: attributeType === "VirtualIntensity",
    value_polarity:
      attributeType === "Pan" || attributeType === "Tilt"
        ? ParameterValuePolarity.Signed
        : ParameterValuePolarity.Unsigned,
  };
}

/**
 * Builds custom parameter metadata for fixture-specific control channels.
 */
function customParameter(
  label: string,
  max = 255,
): FixtureElement["parameters"][number] {
  return {
    attribute: { type: "Custom", data: { label } },
    is_inverted: false,
    is_snap: false,
    max,
    min: 0,
    merge_type: MergeStrategy.LTP,
    offset: { type: "Absolute", data: { value: 0 } },
    resolution: DmxValueResolution.Coarse,
    use_grandmaster: false,
  };
}

type MovingHeadTestDmx = {
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

/**
 * Builds a fixture element with optional transform and parameter metadata.
 */
function element(
  label: string,
  attributeTypes: Array<Exclude<Attribute["type"], "Custom">>,
): FixtureElement {
  return {
    label,
    parameters: attributeTypes.map((attributeType) =>
      parameter(attributeType, attributeType === "Tilt" ? 540 : 255),
    ),
  };
}

/**
 * Builds strobe elements where the control element appears before emitters.
 */
function controlFirstStrobeElements(whiteSegmentCount = 16): FixtureElement[] {
  return [
    element("Tilt Axis", ["Tilt"]),
    {
      label: "Rotation Speed",
      parameters: [customParameter("Rotation Speed")],
    },
    { label: "Reset", parameters: [] },
    ...Array.from({ length: whiteSegmentCount }, (_, index) =>
      element(`Strobe Dimmer ${index + 1}`, ["VirtualIntensity", "White"]),
    ),
    ...Array.from({ length: 96 }, (_, index) =>
      element(`RGB Pixel ${index + 1}`, [
        "VirtualIntensity",
        "Red",
        "Green",
        "Blue",
      ]),
    ),
  ];
}

/**
 * Builds RGB strobe bar elements used to verify emitter placement.
 */
function rgbStrobeBarElements(): FixtureElement[] {
  return [
    ...Array.from({ length: 24 }, (_, index) =>
      element(`White Segment ${index + 1}`, ["VirtualIntensity", "White"]),
    ),
    ...Array.from({ length: 24 }, (_, index) =>
      element(`Top RGB Segment ${index + 1}`, [
        "VirtualIntensity",
        "Red",
        "Green",
        "Blue",
      ]),
    ),
    ...Array.from({ length: 24 }, (_, index) =>
      element(`Bottom RGB Segment ${index + 1}`, [
        "VirtualIntensity",
        "Red",
        "Green",
        "Blue",
      ]),
    ),
  ];
}

/**
 * Builds Generic wash beam elements with control, beams, and decorative strip pixels.
 */
function rotatingWashBeamElements(): FixtureElement[] {
  return [
    {
      label: "Control",
      parameters: [
        parameter("Tilt", 270),
        customParameter("Tilt Speed"),
        parameter("Zoom"),
        parameter("Intensity"),
      ],
    },
    ...Array.from({ length: 12 }, (_, index) =>
      element(`Beam ${index + 1}`, ["Red", "Green", "Blue", "White"]),
    ),
    ...Array.from({ length: 12 }, (_, index) =>
      element(`Top Strip Pixel ${index + 1}`, [
        "Red",
        "Green",
        "Blue",
        "White",
        "Yellow",
      ]),
    ),
    ...Array.from({ length: 12 }, (_, index) =>
      element(`Bottom Strip Pixel ${index + 1}`, [
        "Red",
        "Green",
        "Blue",
        "White",
        "Yellow",
      ]),
    ),
  ];
}

/** Verifies moving-head zero pan and tilt keep the fallback model in its neutral hanging pose. */
test("fallback moving head keeps zero pan/tilt hanging straight down", () => {
  const instance = buildMovingHeadFixture("fixture-1", [
    { label: "Main" } as FixtureElement,
  ]);

  updateMovingHeadColors(
    instance,
    new Map([
      [
        "Main",
        {
          red: 0,
          green: 0,
          blue: 0,
          intensity: 0,
          pan: 0,
          tilt: 0,
          zoom: 0.5,
          frost: 0,
        },
      ],
    ]),
  );

  instance.group.updateMatrixWorld(true);

  const basePosition = new Vector3();
  const headPosition = new Vector3();
  const beamTargetPosition = new Vector3();

  instance.nodeObjects.get("Base")?.getWorldPosition(basePosition);
  instance.movingHeadData.headGroup.getWorldPosition(headPosition);
  instance.movingHeadData.spotlightTarget.getWorldPosition(beamTargetPosition);

  approx(instance.movingHeadData.yokeGroup.rotation.y, 0);
  approx(instance.movingHeadData.headGroup.rotation.x, 0);
  assert.ok(
    basePosition.y > headPosition.y,
    `expected hanging base above head, got base=${basePosition.y} head=${headPosition.y}`,
  );
  assert.ok(
    beamTargetPosition.y < headPosition.y,
    `expected zero tilt to aim below the head, got target=${beamTargetPosition.y} head=${headPosition.y}`,
  );
});

/** Verifies moving-head pan and tilt values are signed offsets from the zero reference. */
test("moving head pan/tilt values are applied as signed offsets from zero", () => {
  const instance = buildMovingHeadFixture("fixture-2", [
    { label: "Main" } as FixtureElement,
  ]);

  updateMovingHeadColors(
    instance,
    new Map([
      [
        "Main",
        {
          red: 0,
          green: 0,
          blue: 0,
          intensity: 0,
          pan: 90 / 540,
          tilt: -45 / 270,
          zoom: 0.5,
          frost: 0,
        },
      ],
    ]),
  );

  approx(instance.movingHeadData.yokeGroup.rotation.y, MathUtils.degToRad(90));
  approx(instance.movingHeadData.headGroup.rotation.x, MathUtils.degToRad(-45));
});

/** Verifies missing pan and tilt output keeps the fallback moving head in its neutral load pose. */
test("moving head keeps yoke arms on x axis when pan and tilt output is absent", () => {
  const elementWithPanTilt: FixtureElement = {
    label: "Head",
    parameters: [parameter("Pan", 540), parameter("Tilt", 270)],
  };
  const instance = buildMovingHeadFixture("fixture-missing-pan-tilt", [
    elementWithPanTilt,
  ]);
  const dmx = extractVisualizerDmx({}, elementWithPanTilt);

  assert.equal(dmx.pan, undefined);
  assert.equal(dmx.tilt, undefined);

  updateMovingHeadColors(instance, new Map([["Head", dmx]]));
  instance.group.updateMatrixWorld(true);

  const leftArm = instance.group.getObjectByName("LeftArm");
  const rightArm = instance.group.getObjectByName("RightArm");
  assert.ok(leftArm);
  assert.ok(rightArm);

  const leftPosition = new Vector3();
  const rightPosition = new Vector3();
  leftArm.getWorldPosition(leftPosition);
  rightArm.getWorldPosition(rightPosition);

  assert.ok(leftPosition.x < rightPosition.x);
  approx(leftPosition.z, rightPosition.z);
  approx(instance.movingHeadData.yokeGroup.rotation.y, 0);
  approx(instance.movingHeadData.headGroup.rotation.x, 0);
});

/** Verifies explicitly asserted zero pan and tilt keep the fallback moving head in its load pose. */
test("moving head keeps neutral pose when pan and tilt output is zero", () => {
  const elementWithPanTilt: FixtureElement = {
    label: "Head",
    parameters: [parameter("Pan", 540), parameter("Tilt", 270)],
  };
  const instance = buildMovingHeadFixture("fixture-zero-pan-tilt", [
    elementWithPanTilt,
  ]);
  const dmx = extractVisualizerDmx({ Pan: 0, Tilt: 0 }, elementWithPanTilt);

  assert.equal(dmx.pan, 0);
  assert.equal(dmx.tilt, 0);

  updateMovingHeadColors(instance, new Map([["Head", dmx]]));

  approx(instance.movingHeadData.yokeGroup.rotation.y, 0);
  approx(instance.movingHeadData.headGroup.rotation.x, 0);
});

/** Verifies signed pan and tilt outputs are treated as logical degree offsets, not raw DMX fractions. */
test("moving head treats signed pan and tilt output as degree offsets", () => {
  const elementWithPanTilt: FixtureElement = {
    label: "Head",
    parameters: [parameter("Pan", 65_535), parameter("Tilt", 65_535)],
  };
  const instance = buildMovingHeadFixture("fixture-signed-pan-tilt", [
    elementWithPanTilt,
  ]);
  const dmx = extractVisualizerDmx({ Pan: 90, Tilt: -45 }, elementWithPanTilt);
  const elementDmx = extractElementDmxData(
    { Pan: 90, Tilt: -45 },
    elementWithPanTilt,
  );

  assert.equal(dmx.pan, 90 / 540);
  assert.equal(dmx.tilt, -45 / 270);
  assert.equal(elementDmx.Pan, 90 / 540);
  assert.equal(elementDmx.Tilt, -45 / 270);
  assert.equal(elementDmx.pan, 90 / 540);
  assert.equal(elementDmx.tilt, -45 / 270);

  updateMovingHeadColors(instance, new Map([["Head", dmx]]));

  approx(instance.movingHeadData.yokeGroup.rotation.y, MathUtils.degToRad(90));
  approx(instance.movingHeadData.headGroup.rotation.x, MathUtils.degToRad(-45));
});

/**
 * Verifies the moving-head floor footprint is synthetic and does not enable the costly spotlight.
 */
test("moving head floor footprint follows beam hit without enabling spotlight", () => {
  const instance = buildMovingHeadFixture("fixture-floor-spot", [
    { label: "Main" } as FixtureElement,
  ]);
  instance.group.position.y = 5;

  updateMovingHeadColors(
    instance,
    new Map([
      [
        "Main",
        {
          red: 1,
          green: 0,
          blue: 0,
          intensity: 1,
          pan: 0,
          tilt: -45 / 270,
          zoom: 0.5,
          frost: 0,
        },
      ],
    ]),
  );

  instance.group.updateMatrixWorld(true);

  const floorSpot = instance.movingHeadData.floorSpotMesh;
  const floorSpotWorldPosition = floorSpot.localToWorld(new Vector3(0, 0, 0));
  const floorSpotMaterial = floorSpot.material as MeshBasicMaterial;

  assert.ok(floorSpot.visible);
  assert.equal(instance.movingHeadData.spotLight.visible, false);
  assert.ok(
    floorSpot.scale.x > floorSpot.scale.y,
    `expected angled beam footprint to stretch, got ${floorSpot.scale.x}x${floorSpot.scale.y}`,
  );
  assert.ok(
    floorSpotWorldPosition.y > 0 && floorSpotWorldPosition.y < 0.01,
    `expected footprint just above floor, got y=${floorSpotWorldPosition.y}`,
  );
  assert.ok(
    floorSpotMaterial.opacity > 0,
    `expected visible footprint opacity, got ${floorSpotMaterial.opacity}`,
  );

  updateMovingHeadColors(
    instance,
    new Map([
      [
        "Main",
        {
          red: 1,
          green: 0,
          blue: 0,
          intensity: 0,
          pan: 0,
          tilt: -45 / 270,
          zoom: 0.5,
          frost: 0,
        },
      ],
    ]),
  );

  assert.equal(floorSpot.visible, false);
  assert.equal(floorSpotMaterial.opacity, 0);
});

/**
 * Verifies moving-head floor footprints stay aligned to the world floor
 * when the fixture is mounted on a rotated parent.
 */
test("moving head floor footprint remains world-floor aligned under rotated fixture groups", () => {
  const instance = buildMovingHeadFixture("fixture-rotated-floor-spot", [
    { label: "Main" } as FixtureElement,
  ]);
  instance.group.position.y = 5;
  instance.group.rotation.z = MathUtils.degToRad(25);

  updateMovingHeadColors(
    instance,
    new Map([
      [
        "Main",
        {
          red: 1,
          green: 0,
          blue: 0,
          intensity: 1,
          pan: 0,
          tilt: -45 / 270,
          zoom: 0.5,
          frost: 0,
        },
      ],
    ]),
  );
  instance.group.updateMatrixWorld(true);

  const floorSpot = instance.movingHeadData.floorSpotMesh;
  const floorSpotWorldQuaternion = floorSpot.getWorldQuaternion(
    new Quaternion(),
  );
  const floorSpotNormal = new Vector3(0, 0, 1)
    .applyQuaternion(floorSpotWorldQuaternion)
    .normalize();
  const floorSpotWorldPosition = floorSpot.localToWorld(new Vector3(0, 0, 0));

  assert.ok(floorSpot.visible);
  assert.ok(
    Math.abs(floorSpotNormal.dot(new Vector3(0, 1, 0))) > 0.999,
    `expected footprint normal to align with world floor, got ${floorSpotNormal.x}, ` +
      `${floorSpotNormal.y}, ${floorSpotNormal.z}`,
  );
  assert.ok(
    floorSpotWorldPosition.y > 0 && floorSpotWorldPosition.y < 0.01,
    `expected footprint just above floor, got y=${floorSpotWorldPosition.y}`,
  );
});

/**
 * Verifies low-quality moving-head beams keep the full cone and use depth-tested low opacity.
 */
test("low quality moving head beam keeps full geometry with depth-tested material", () => {
  const instance = buildMovingHeadFixture(
    "fixture-low-quality-depth-tested",
    [{ label: "Main" } as FixtureElement],
    undefined,
    "low",
  );
  instance.group.position.y = 5;

  updateMovingHeadColors(
    instance,
    new Map([
      [
        "Main",
        {
          red: 1,
          green: 1,
          blue: 1,
          intensity: 1,
          pan: 0,
          tilt: -45 / 270,
          zoom: 0.5,
          frost: 0,
        },
      ],
    ]),
  );

  assert.ok(isLowQualityBeamMaterial(instance.movingHeadData.beamMaterial));
  assert.equal(instance.movingHeadData.beamMaterial.depthTest, true);
  assert.equal(
    instance.movingHeadData.beamMaterial.lowQualityClipYUniform.value,
    0,
  );
  assert.equal(instance.movingHeadData.beamMaterial.forceSinglePass, true);
  assert.equal(instance.movingHeadData.beamMesh.scale.y, 50);
  assert.ok(instance.movingHeadData.beamMaterial.opacity <= 0.3);
});

test("fallback LED bar hangs emitters below the housing", () => {
  const instance = buildSimpleLedBar("fixture-led", [
    { label: "Pixel 1" } as FixtureElement,
    { label: "Pixel 2" } as FixtureElement,
  ]);

  instance.group.updateMatrixWorld(true);

  const housingPosition = new Vector3();
  const emitterPosition = new Vector3();

  instance.group.getObjectByName("Housing")?.getWorldPosition(housingPosition);
  instance.emitters.get("0")?.mesh.getWorldPosition(emitterPosition);

  assert.ok(
    housingPosition.y > emitterPosition.y,
    `expected LED housing above emitters, got housing=${housingPosition.y} emitter=${emitterPosition.y}`,
  );
});

/**
 * Verifies fallback strobe panels rotate around their base attachment point.
 */
test("fallback strobe rotates around its base attachment point", () => {
  const instance = buildStrobePanelFixture("fixture-strobe", []);

  updateStrobePanelColors(instance, new Map());
  instance.group.updateMatrixWorld(true);

  const leftArm = instance.group.getObjectByName("LeftArm");
  const base = instance.group.getObjectByName("Base");
  const face = instance.group.getObjectByName("Face");
  const topPixel = instance.strobePanelData.pixelMeshes[0];
  const panelPosition = new Vector3();
  const basePosition = new Vector3();
  const topPixelPosition = new Vector3();

  assert.ok(leftArm);
  assert.ok(base);
  assert.ok(face);

  instance.strobePanelData.panelGroup.getWorldPosition(panelPosition);
  base.getWorldPosition(basePosition);
  topPixel.getWorldPosition(topPixelPosition);

  const leftArmSize = boxGeometrySize(
    leftArm as unknown as { geometry: unknown },
  );
  const baseSize = boxGeometrySize(base as unknown as { geometry: unknown });
  const faceLocalPosition = face as { position: { y: number } };
  const armPosition = leftArm as { position: { y: number } };
  const baseLocalPosition = base as { position: { y: number } };
  const armTopY = armPosition.position.y + leftArmSize.height / 2;
  const armBottomY = armPosition.position.y - leftArmSize.height / 2;

  approx(armBottomY, 0);
  approx(baseLocalPosition.position.y, armBottomY);
  approx(instance.strobePanelData.panelGroup.position.y, armTopY);
  approx(basePosition.y, 0);
  assert.ok(
    panelPosition.y < basePosition.y,
    `expected zero-rotation strobe model to hang below the base pivot, got panel=${panelPosition.y} base=${basePosition.y}`,
  );
  assert.ok(
    baseSize.width > leftArmSize.width * 2,
    `expected base to span between both arms, got baseWidth=${baseSize.width} armWidth=${leftArmSize.width}`,
  );
  approx(faceLocalPosition.position.y, 0);
  assert.ok(
    topPixelPosition.y < basePosition.y,
    `expected zero-rotation emitter face below the base pivot, got topPixel=${topPixelPosition.y} base=${basePosition.y}`,
  );

  instance.group.rotation.x = Math.PI;
  instance.group.updateMatrixWorld(true);
  instance.strobePanelData.panelGroup.getWorldPosition(panelPosition);
  topPixel.getWorldPosition(topPixelPosition);

  assert.ok(
    panelPosition.y > basePosition.y,
    `expected 180 degree fixture rotation to pivot around the base and lift the panel, got panel=${panelPosition.y} base=${basePosition.y}`,
  );
  assert.ok(
    topPixelPosition.y > 0,
    `expected sample-data 180 degree rotation to lift the strobe above the floor, got topPixel=${topPixelPosition.y}`,
  );
});

/** Verifies asserted zero tilt keeps the strobe matrix at its neutral reference pose. */
test("strobe matrix treats zero tilt as neutral reference", () => {
  const instance = buildStrobePanelFixture(
    "fixture-strobe-zero-tilt",
    controlFirstStrobeElements(),
  );

  updateStrobePanelColors(
    instance,
    new Map([
      ["Tilt Axis", { red: 0, green: 0, blue: 0, intensity: 0, tilt: 0 }],
    ]),
  );

  approx(
    instance.strobePanelData.panelGroup.rotation.x,
    MathUtils.degToRad(-90),
  );
});

test("strobe renderer maps control-first profiles to the physical emitters", () => {
  const instance = buildStrobePanelFixture(
    "fixture-strobe",
    controlFirstStrobeElements(),
  );

  updateStrobePanelColors(
    instance,
    new Map([
      ["RGB Pixel 1", { red: 1, green: 0, blue: 0, intensity: 1 }],
      ["RGB Pixel 78", { red: 0, green: 0, blue: 0, intensity: 1 }],
      [
        "Strobe Dimmer 1",
        { red: 0, green: 0, blue: 0, intensity: 0, white: 1 },
      ],
    ]),
  );

  const firstPixelMaterial = instance.strobePanelData.pixelMeshes[0]
    .material as MeshBasicMaterial;
  const firstWhiteMaterial = instance.strobePanelData.whiteSegmentMeshes[0]
    .material as MeshBasicMaterial;

  assert.ok(
    firstPixelMaterial.color.r > 0.9 &&
      firstPixelMaterial.color.g < 0.01 &&
      firstPixelMaterial.color.b < 0.01,
    `expected first pixel to read RGB Pixel 1, got ${firstPixelMaterial.color.r},${firstPixelMaterial.color.g},${firstPixelMaterial.color.b}`,
  );
  assert.ok(
    firstWhiteMaterial.color.r < 0.01,
    `expected first strobe segment to stay dark, got ${firstWhiteMaterial.color.r}`,
  );
});

/** Verifies the 312-channel profile renders and controls all twenty white segments. */
test("strobe renderer supports twenty white segments", () => {
  const instance = buildStrobePanelFixture(
    "fixture-strobe-312ch",
    controlFirstStrobeElements(20),
  );

  updateStrobePanelColors(
    instance,
    new Map([
      [
        "Strobe Dimmer 20",
        { red: 0, green: 0, blue: 0, intensity: 1, white: 1 },
      ],
    ]),
  );

  assert.equal(instance.strobePanelData.whiteSegmentMeshes.length, 20);
  assert.equal(instance.strobePanelData.whiteSegmentElementLabels.length, 20);
  const lastWhiteMaterial = instance.strobePanelData.whiteSegmentMeshes[19]
    .material as MeshBasicMaterial;
  assert.ok(
    lastWhiteMaterial.color.r > 0.9,
    `expected the twentieth white segment to follow Strobe Dimmer 20, got ${lastWhiteMaterial.color.r}`,
  );
});

test("rgb strobe bar renderer maps requested element groups left-to-right", () => {
  const instance = buildRgbStrobeBarFixture(
    "fixture-rgb-strobe-bar",
    rgbStrobeBarElements(),
  );

  updateStrobePanelColors(
    instance,
    new Map([
      [
        "White Segment 1",
        { red: 1, green: 1, blue: 1, intensity: 1, white: 1 },
      ],
      ["Top RGB Segment 1", { red: 1, green: 0, blue: 0, intensity: 1 }],
      ["Bottom RGB Segment 24", { red: 0, green: 0, blue: 1, intensity: 1 }],
    ]),
  );

  const firstWhiteMaterial = instance.strobePanelData.whiteSegmentMeshes[0]
    .material as MeshBasicMaterial;
  const firstTopMaterial = instance.strobePanelData.pixelMeshes[0]
    .material as MeshBasicMaterial;
  const lastBottomMaterial = instance.strobePanelData.pixelMeshes[47]
    .material as MeshBasicMaterial;

  assert.ok(
    firstWhiteMaterial.color.r > 0.9 &&
      firstWhiteMaterial.color.g > 0.9 &&
      firstWhiteMaterial.color.b > 0.9,
    `expected first white segment to follow White Segment 1, got ${firstWhiteMaterial.color.r},${firstWhiteMaterial.color.g},${firstWhiteMaterial.color.b}`,
  );
  assert.ok(
    firstTopMaterial.color.r > 0.9 &&
      firstTopMaterial.color.g < 0.01 &&
      firstTopMaterial.color.b < 0.01,
    `expected first top segment to follow Top RGB Segment 1, got ${firstTopMaterial.color.r},${firstTopMaterial.color.g},${firstTopMaterial.color.b}`,
  );
  assert.ok(
    lastBottomMaterial.color.r < 0.01 &&
      lastBottomMaterial.color.g < 0.01 &&
      lastBottomMaterial.color.b > 0.9,
    `expected last bottom segment to follow Bottom RGB Segment 24, got ${lastBottomMaterial.color.r},${lastBottomMaterial.color.g},${lastBottomMaterial.color.b}`,
  );

  updateStrobePanelColors(
    instance,
    new Map([
      [
        "White Segment 1",
        { red: 1, green: 1, blue: 1, intensity: 0, white: 1 },
      ],
    ]),
  );
  assert.ok(
    firstWhiteMaterial.color.r < 0.01 &&
      firstWhiteMaterial.color.g < 0.01 &&
      firstWhiteMaterial.color.b < 0.01,
    `expected first white segment to follow vdimmer, got ${firstWhiteMaterial.color.r},${firstWhiteMaterial.color.g},${firstWhiteMaterial.color.b}`,
  );

  const firstTopMesh = instance.strobePanelData.pixelMeshes[0];
  const lastBottomMesh = instance.strobePanelData.pixelMeshes[47];
  const firstTopSize = boxGeometrySize(firstTopMesh);
  const firstWhiteSize = boxGeometrySize(
    instance.strobePanelData.whiteSegmentMeshes[0],
  );
  const housing =
    instance.strobePanelData.panelGroup.getObjectByName("Housing");
  assert.ok(housing);
  const housingSize = boxGeometrySize(
    housing as unknown as { geometry: unknown },
  );

  approx(firstTopSize.width / firstTopSize.height, 5 / 2);
  approx(firstWhiteSize.width / firstWhiteSize.height, 5);
  approx(
    firstTopMesh.position.y +
      firstTopSize.height / 2 -
      (lastBottomMesh.position.y - firstTopSize.height / 2),
    2 * 0.0254,
  );
  approx(housingSize.width, 1);
  approx(housingSize.height, 3 * 0.0254);
  approx(housingSize.depth, 3 * 0.0254);
});

/**
 * Verifies indexed non-GDTF updates still drive RGB strobe bar white segments through virtual intensity.
 */
test("rgb strobe bar renderer maps indexed white segment virtual intensity", () => {
  const instance = buildRgbStrobeBarFixture(
    "fixture-rgb-strobe-bar-indexed",
    rgbStrobeBarElements(),
  );

  updateStrobePanelColors(
    instance,
    new Map([
      ["0", { red: 1, green: 1, blue: 1, intensity: 1, white: 1 }],
      ["24", { red: 1, green: 0, blue: 0, intensity: 1 }],
    ]),
  );

  const firstWhiteMaterial = instance.strobePanelData.whiteSegmentMeshes[0]
    .material as MeshBasicMaterial;
  const firstTopMaterial = instance.strobePanelData.pixelMeshes[0]
    .material as MeshBasicMaterial;

  assert.ok(
    firstWhiteMaterial.color.r > 0.9 &&
      firstWhiteMaterial.color.g > 0.9 &&
      firstWhiteMaterial.color.b > 0.9,
    `expected indexed white segment to light, got ${firstWhiteMaterial.color.r},${firstWhiteMaterial.color.g},${firstWhiteMaterial.color.b}`,
  );
  assert.ok(
    firstTopMaterial.color.r > 0.9 &&
      firstTopMaterial.color.g < 0.01 &&
      firstTopMaterial.color.b < 0.01,
    `expected indexed top segment to light red, got ${firstTopMaterial.color.r},${firstTopMaterial.color.g},${firstTopMaterial.color.b}`,
  );

  updateStrobePanelColors(
    instance,
    new Map([["0", { red: 1, green: 1, blue: 1, intensity: 0, white: 1 }]]),
  );

  assert.ok(
    firstWhiteMaterial.color.r < 0.01 &&
      firstWhiteMaterial.color.g < 0.01 &&
      firstWhiteMaterial.color.b < 0.01,
    `expected indexed white segment to follow virtual intensity, got ${firstWhiteMaterial.color.r},${firstWhiteMaterial.color.g},${firstWhiteMaterial.color.b}`,
  );
});

/**
 * Verifies explicit Generic renderers override supplied GDTF geometry in previews and scenes.
 */
test("renderer registry prefers explicit Generic renderers over GDTF geometry", () => {
  const geometry = emptyGeometry();

  assert.equal(detectRendererType(FixtureLayout.StrobeMatrix), "strobe-panel");
  const matrix = buildFixtureWithRenderer(
    "fixture-generic-gdtf-strobe",
    geometry,
    controlFirstStrobeElements(),
    undefined,
    "high",
    FixtureLayout.StrobeMatrix,
  );
  assert.equal(matrix.rendererType, "strobe-panel");
  assert.ok(matrix.group.getObjectByName("Face"));
  assert.ok(matrix.group.getObjectByName("LeftArm"));

  const bar = buildFixtureWithRenderer(
    "fixture-generic-rgb-strobe-bar",
    geometry,
    rgbStrobeBarElements(),
    undefined,
    "high",
    FixtureLayout.RgbStrobeBar,
  );
  assert.equal(bar.rendererType, "strobe-panel");
  assert.equal(bar.strobePanelData?.layout, "rgb-strobe-bar");

  const wash = buildFixtureWithRenderer(
    "fixture-rotating-wash-beam",
    geometry,
    rotatingWashBeamElements(),
    undefined,
    "high",
    FixtureLayout.RotatingWashBeam,
  );
  assert.equal(wash.rendererType, "rotating-wash-beam");
  assert.equal(wash.rotatingWashBeamData?.beamEmitters.length, 12);

  const spot = buildFixtureWithRenderer(
    "fixture-generic-moving-spot",
    geometry,
    [{ label: "Main", parameters: [] }],
    undefined,
    "high",
    FixtureLayout.MovingHead,
  );
  assert.equal(spot.rendererType, "moving-head");
  const leftArm = spot.group.getObjectByName("LeftArm");
  const rightArm = spot.group.getObjectByName("RightArm");
  assert.ok(leftArm);
  assert.ok(rightArm);
  assert.ok(leftArm.position.x < 0);
  assert.ok(rightArm.position.x > 0);
  approx(leftArm.position.z, 0);
  approx(rightArm.position.z, 0);
});

/**
 * Verifies the Generic wash beam renderer presents beams and strip pixels left-to-right.
 */
test("generic wash beam renderer maps beams and strips left-to-right", () => {
  const instance = buildRotatingWashBeamFixture(
    "fixture-rotating-wash-beam",
    rotatingWashBeamElements(),
  );

  updateRotatingWashBeamColors(
    instance,
    new Map([
      ["0", { red: 0, green: 0, blue: 0, intensity: 1, tilt: 0, zoom: 0.5 }],
      ["1", { red: 1, green: 0, blue: 0, intensity: 1 }],
      ["12", { red: 0, green: 0, blue: 1, intensity: 1 }],
      ["13", { red: 0, green: 1, blue: 0, intensity: 1 }],
      ["36", { red: 1, green: 1, blue: 0, intensity: 1 }],
    ]),
  );

  const firstBeamMaterial = instance.rotatingWashBeamData.beamEmitters[0]
    .lensMesh.material as MeshBasicMaterial;
  const lastBeamMaterial = instance.rotatingWashBeamData.beamEmitters[11]
    .lensMesh.material as MeshBasicMaterial;
  const firstTopStripMaterial = instance.rotatingWashBeamData
    .stripPixelMeshes[0].material as MeshBasicMaterial;
  const lastBottomStripMaterial = instance.rotatingWashBeamData
    .stripPixelMeshes[23].material as MeshBasicMaterial;

  assert.ok(
    firstBeamMaterial.color.r > 0.9 &&
      firstBeamMaterial.color.g < 0.01 &&
      firstBeamMaterial.color.b < 0.01,
    `expected first beam to follow Beam 1, got ${firstBeamMaterial.color.r},${firstBeamMaterial.color.g},${firstBeamMaterial.color.b}`,
  );
  assert.ok(
    lastBeamMaterial.color.r < 0.01 &&
      lastBeamMaterial.color.g < 0.01 &&
      lastBeamMaterial.color.b > 0.9,
    `expected last beam to follow Beam 12, got ${lastBeamMaterial.color.r},${lastBeamMaterial.color.g},${lastBeamMaterial.color.b}`,
  );
  assert.ok(
    firstTopStripMaterial.color.r < 0.01 &&
      firstTopStripMaterial.color.g > 0.9 &&
      firstTopStripMaterial.color.b < 0.01,
    `expected first top strip pixel to follow Top Strip Pixel 1, got ${firstTopStripMaterial.color.r},${firstTopStripMaterial.color.g},${firstTopStripMaterial.color.b}`,
  );
  assert.ok(
    lastBottomStripMaterial.color.r > 0.9 &&
      lastBottomStripMaterial.color.g > 0.9 &&
      lastBottomStripMaterial.color.b < 0.01,
    `expected last bottom strip pixel to follow Bottom Strip Pixel 12, got ${lastBottomStripMaterial.color.r},${lastBottomStripMaterial.color.g},${lastBottomStripMaterial.color.b}`,
  );

  const base = instance.nodeObjects.get("Base");
  const housing = instance.nodeObjects.get("Housing");
  assert.ok(base);
  assert.ok(housing);
  assert.equal(base.parent, instance.group);
  const housingSize = boxGeometrySize(
    housing as unknown as { geometry: unknown },
  );
  const baseRail = base.getObjectByName("BaseRail");
  assert.ok(baseRail);
  const baseRailSize = boxGeometrySize(
    baseRail as unknown as { geometry: unknown },
  );
  approx(housingSize.width, 0.922);
  approx(housingSize.height, 0.215);
  approx(baseRailSize.width, 1.0);
  const housingPosition = housing as unknown as { position: { y: number } };
  const baseRailPosition = baseRail as unknown as { position: { y: number } };
  const fixtureTopY = housingPosition.position.y + housingSize.height / 2;
  const fixtureBottomY = baseRailPosition.position.y - baseRailSize.height / 2;
  approx(fixtureTopY - fixtureBottomY, 15 * 0.0254);
  approx(baseRail.position.z, 0);
  approx(base.getObjectByName("LeftPivotSupport")?.position.z ?? NaN, 0);
  approx(base.getObjectByName("RightPivotSupport")?.position.z ?? NaN, 0);
  approx(base.getObjectByName("LeftPivotBoss")?.position.z ?? NaN, 0);
  approx(base.getObjectByName("RightPivotBoss")?.position.z ?? NaN, 0);

  instance.group.updateMatrixWorld(true);
  const beamOrigin =
    instance.rotatingWashBeamData.beamEmitters[0].beamNode.localToWorld(
      new Vector3(0, 0, 0),
    );
  const beamTip =
    instance.rotatingWashBeamData.beamEmitters[0].beamNode.localToWorld(
      new Vector3(0, -1, 0),
    );
  const beamDirection = beamTip.sub(beamOrigin).normalize();

  assert.ok(instance.rotatingWashBeamData.beamEmitters[0].beamMesh.visible);
  approx(
    instance.rotatingWashBeamData.tiltGroup.rotation.x,
    MathUtils.degToRad(-90),
  );
  assert.ok(
    beamDirection.y > 0.9,
    `expected zero tilt to aim upward, got ${beamDirection.x},${beamDirection.y},${beamDirection.z}`,
  );
});

/** Verifies asserted zero tilt keeps the Generic wash beam at its neutral reference pose. */
test("generic wash beam treats zero tilt as neutral reference", () => {
  const instance = buildRotatingWashBeamFixture(
    "fixture-rotating-wash-beam-zero-tilt",
    rotatingWashBeamElements(),
  );

  updateRotatingWashBeamColors(
    instance,
    new Map([
      ["0", { red: 0, green: 0, blue: 0, intensity: 1, tilt: 0, zoom: 0.5 }],
    ]),
  );

  approx(
    instance.rotatingWashBeamData.tiltGroup.rotation.x,
    MathUtils.degToRad(-90),
  );
});

/**
 * Verifies low-quality mode keeps Generic beams visible without volumetric shader materials or SpotLights.
 */
test("generic wash beam low quality uses cheap beam materials", () => {
  const instance = buildRotatingWashBeamFixture(
    "fixture-rotating-wash-beam-low",
    rotatingWashBeamElements(),
    "low",
  );

  updateRotatingWashBeamColors(
    instance,
    new Map([
      ["0", { red: 0, green: 0, blue: 0, intensity: 1, tilt: 0, zoom: 0.5 }],
      ["1", { red: 1, green: 0.5, blue: 0.25, intensity: 1 }],
    ]),
  );

  const beam = instance.rotatingWashBeamData.beamEmitters[0];
  assert.ok(isLowQualityBeamMaterial(beam.beamMaterial));
  assert.equal(beam.beamMaterial.forceSinglePass, true);
  assert.equal(beam.beamMesh.visible, true);
  assert.equal(beam.spotLight.visible, false);
  assert.equal(beam.spotLight.intensity, 0);
  assert.equal(beam.floorSpotMesh.visible, false);
  assert.ok(
    beam.beamMaterial.opacity > 0,
    `expected visible low-quality beam opacity, got ${beam.beamMaterial.opacity}`,
  );
});

/**
 * Verifies high-quality Generic wash beams use synthetic floor footprints instead of costly SpotLights.
 */
test("generic wash beam high quality uses synthetic floor footprints", () => {
  const instance = buildRotatingWashBeamFixture(
    "fixture-rotating-wash-beam-floor-spot",
    rotatingWashBeamElements(),
    "high",
  );
  instance.group.position.y = 5;

  updateRotatingWashBeamColors(
    instance,
    new Map([
      [
        "0",
        { red: 0, green: 0, blue: 0, intensity: 1, tilt: 135 / 270, zoom: 0.5 },
      ],
      ["1", { red: 1, green: 0.5, blue: 0.25, intensity: 1 }],
    ]),
  );
  instance.group.updateMatrixWorld(true);

  const beam = instance.rotatingWashBeamData.beamEmitters[0];
  const floorSpot = beam.floorSpotMesh;
  const floorSpotWorldPosition = floorSpot.localToWorld(new Vector3(0, 0, 0));
  const floorSpotMaterial = floorSpot.material as MeshBasicMaterial;

  assert.equal(beam.spotLight.visible, false);
  assert.equal(beam.spotLight.intensity, 0);
  assert.ok(floorSpot.visible);
  assert.ok(
    floorSpot.scale.x > floorSpot.scale.y,
    `expected angled Generic beam footprint to stretch, got ${floorSpot.scale.x}x${floorSpot.scale.y}`,
  );
  assert.ok(
    floorSpotWorldPosition.y > 0 && floorSpotWorldPosition.y < 0.01,
    `expected Generic footprint just above floor, got y=${floorSpotWorldPosition.y}`,
  );
  assert.ok(
    floorSpotMaterial.opacity > 0,
    `expected visible Generic footprint opacity, got ${floorSpotMaterial.opacity}`,
  );
});

/**
 * Verifies high-quality Generic beams keep independent shader uniforms per emitter.
 */
test("generic wash beam high quality keeps per-beam material uniforms", () => {
  const instance = buildRotatingWashBeamFixture(
    "fixture-rotating-wash-beam-independent-materials",
    rotatingWashBeamElements(),
    "high",
  );

  updateRotatingWashBeamColors(
    instance,
    new Map([
      [
        "0",
        { red: 0, green: 0, blue: 0, intensity: 1, tilt: 135 / 270, zoom: 0.5 },
      ],
      ["1", { red: 0, green: 0, blue: 0, intensity: 0 }],
      ["2", { red: 1, green: 0, blue: 0, intensity: 1 }],
    ]),
  );

  const firstBeam = instance.rotatingWashBeamData.beamEmitters[0];
  const secondBeam = instance.rotatingWashBeamData.beamEmitters[1];
  if (
    isLowQualityBeamMaterial(firstBeam.beamMaterial) ||
    isLowQualityBeamMaterial(secondBeam.beamMaterial)
  ) {
    assert.fail("expected high-quality Generic beam materials");
  }

  assert.notEqual(firstBeam.beamMaterial, secondBeam.beamMaterial);
  assert.equal(firstBeam.beamMaterial.beamIntensityUniform.value, 0);
  assert.equal(secondBeam.beamMaterial.beamIntensityUniform.value, 1);
  assert.ok(
    secondBeam.beamMaterial.beamColorUniform.value.x > 0.9,
    `expected second beam to keep red material uniforms, got ${secondBeam.beamMaterial.beamColorUniform.value.x}`,
  );
});

/**
 * Verifies the Generic wash beam zero/default speed matches the moving-head baseline.
 */
test("generic wash beam zero tilt speed uses moving-head baseline", () => {
  const controlElement = rotatingWashBeamElements()[0];
  const controlDmx = extractElementDmxData(
    { "Tilt Speed": 128 },
    controlElement,
  );
  const spotSpeedDmx = extractElementDmxData(
    { "Pan/Tilt Speed": 128 },
    { label: "Head", parameters: [customParameter("Pan/Tilt Speed")] },
  );
  const strobeSpeedDmx = extractElementDmxData(
    { "Rotation Speed": 128 },
    {
      label: "Rotation Speed",
      parameters: [customParameter("Rotation Speed")],
    },
  );
  const ambiguousCustomDmx = extractElementDmxData(
    { Custom: 255 },
    controlElement,
  );
  approx(controlDmx["Tilt Speed"], 128 / 255);
  approx(controlDmx.tiltSpeed, 128 / 255);
  approx(spotSpeedDmx.tiltSpeed, 128 / 255);
  approx(strobeSpeedDmx.tiltSpeed, 128 / 255);
  approx(ambiguousCustomDmx.tiltSpeed, 3 / 13);
  assert.equal(ambiguousCustomDmx["Tilt Speed"], undefined);

  const zeroSpeed = buildRotatingWashBeamFixture(
    "fixture-rotating-wash-beam-zero-speed",
    rotatingWashBeamElements(),
  );
  const defaultSpeed = buildRotatingWashBeamFixture(
    "fixture-rotating-wash-beam-default-speed",
    rotatingWashBeamElements(),
  );
  const fast = buildRotatingWashBeamFixture(
    "fixture-rotating-wash-beam-fast",
    rotatingWashBeamElements(),
  );
  const initialControl = {
    red: 0,
    green: 0,
    blue: 0,
    intensity: 1,
    tilt: 0,
    tiltSpeed: 1,
    zoom: 0.5,
  };

  updateRotatingWashBeamColors(zeroSpeed, new Map([["0", initialControl]]));
  updateRotatingWashBeamColors(defaultSpeed, new Map([["0", initialControl]]));
  updateRotatingWashBeamColors(fast, new Map([["0", initialControl]]));

  zeroSpeed.rotatingWashBeamData.lastUpdateTime = performance.now() - 500;
  defaultSpeed.rotatingWashBeamData.lastUpdateTime = performance.now() - 500;
  fast.rotatingWashBeamData.lastUpdateTime = performance.now() - 1000;

  updateRotatingWashBeamColors(
    zeroSpeed,
    new Map([
      [
        "0",
        {
          red: 0,
          green: 0,
          blue: 0,
          intensity: 1,
          tilt: 135 / 270,
          tiltSpeed: 0,
          zoom: 0.5,
        },
      ],
    ]),
  );
  updateRotatingWashBeamColors(
    defaultSpeed,
    new Map([
      [
        "0",
        {
          red: 0,
          green: 0,
          blue: 0,
          intensity: 1,
          tilt: 135 / 270,
          zoom: 0.5,
        },
      ],
    ]),
  );
  updateRotatingWashBeamColors(
    fast,
    new Map([
      [
        "0",
        {
          red: 0,
          green: 0,
          blue: 0,
          intensity: 1,
          tilt: 135 / 270,
          tiltSpeed: 1,
          zoom: 0.5,
        },
      ],
    ]),
  );

  const initialTilt = MathUtils.degToRad(-90);
  const targetTilt = MathUtils.degToRad(45);
  const zeroSpeedTilt = zeroSpeed.rotatingWashBeamData.tiltGroup.rotation.x;
  const defaultSpeedTilt =
    defaultSpeed.rotatingWashBeamData.tiltGroup.rotation.x;
  const fastTilt = fast.rotatingWashBeamData.tiltGroup.rotation.x;

  assert.ok(zeroSpeedTilt > initialTilt && zeroSpeedTilt < targetTilt);
  approx(zeroSpeedTilt, MathUtils.degToRad(0), 0.03);
  approx(defaultSpeedTilt, MathUtils.degToRad(0), 0.03);
  approx(fastTilt, targetTilt);
});

/** Verifies StrobeShutter normalizes into the visualizer DMX aliases. */
test("extract element dmx exposes strobe shutter alias", () => {
  const dmx = extractElementDmxData(
    { StrobeShutter: 128 },
    { label: "Head", parameters: [parameter("StrobeShutter")] },
  );

  approx(dmx.StrobeShutter, 128 / 255);
  approx(dmx.strobeShutter, 128 / 255);
});

/** Verifies white-only emitters inherit a sibling virtual dimmer. */
test("fixture-level virtual intensity dims white-only emitters", () => {
  const elements = [
    { label: "White Segment 1", parameters: [parameter("White")] },
    {
      label: "Top RGB Segment 1",
      parameters: [
        parameter("VirtualIntensity"),
        parameter("Red"),
        parameter("Green"),
        parameter("Blue"),
      ],
    },
  ];

  const litFixtureIntensity = fixtureIntensityValueFromOutputs(
    [{ White: 255 }, { Intensity: 128 }],
    elements,
  );
  const litDmx = extractVisualizerDmx(
    { White: 255 },
    elements[0],
    litFixtureIntensity,
  );
  approx(litDmx.white, 1);
  approx(litDmx.intensity, 128 / 255);

  const darkFixtureIntensity = fixtureIntensityValueFromOutputs(
    [{ White: 255 }, {}],
    elements,
  );
  const darkDmx = extractVisualizerDmx(
    { White: 255 },
    elements[0],
    darkFixtureIntensity,
  );
  approx(darkDmx.white, 1);
  approx(darkDmx.intensity, 0);
});

/** Verifies emitters without a shutter channel can inherit fixture-level shutter. */
test("extract element dmx omits strobe shutter alias without shutter output", () => {
  const dmx = extractElementDmxData(
    { Red: 255, Green: 128, Blue: 0 },
    {
      label: "RGB Pixel 1",
      parameters: [parameter("Red"), parameter("Green"), parameter("Blue")],
    },
  );

  assert.equal(dmx.StrobeShutter, undefined);
  assert.equal(dmx.strobeShutter, undefined);
});

/** Verifies normalized StrobeShutter values map to the visualizer frequency range. */
test("strobe shutter frequency maps one to twenty hertz", () => {
  approx(strobeShutterFrequencyHz(0), 1);
  approx(strobeShutterFrequencyHz(0.5), 10.5);
  approx(strobeShutterFrequencyHz(1), 20);
});

/** Verifies strobe shutter intensity gating is deterministic at a render time. */
test("strobe shutter gates output intensity by phase", () => {
  const frequency = strobeShutterFrequencyHz(0.5);
  const offPhaseSeconds = 0.5 / frequency + 0.001;

  approx(strobeShutterOutputScale(undefined, offPhaseSeconds), 1);
  approx(strobeShutterOutputScale(0, offPhaseSeconds), 1);
  approx(strobeShutterOutputScale(0.5, 0), 1);
  approx(strobeShutterOutputScale(0.5, offPhaseSeconds), 0);
  approx(applyStrobeShutterIntensity(0.8, 0.5, offPhaseSeconds), 0);
});

/** Verifies strobe matrix tilt direction and emitter transforms stay in sync. */
test("strobe tilt refreshes every emitter world matrix", () => {
  const instance = buildStrobePanelFixture(
    "fixture-strobe",
    controlFirstStrobeElements(),
  );
  const emitters = [
    ...instance.strobePanelData.pixelMeshes,
    ...instance.strobePanelData.whiteSegmentMeshes,
  ];

  updateStrobePanelColors(
    instance,
    new Map([
      ["Tilt Axis", { red: 0, green: 0, blue: 0, intensity: 0, tilt: 0 }],
    ]),
  );
  instance.strobePanelData.lastUpdateTime = performance.now() - 1000;
  const neutralRotation = instance.strobePanelData.panelGroup.rotation.x;
  const neutralEmitterNormal = new Vector3(0, 0, 1).applyQuaternion(
    emitters[0].getWorldQuaternion(emitters[0].quaternion.clone()),
  );
  const neutralPositions = emitters.map((mesh) =>
    new Vector3().setFromMatrixPosition(mesh.matrixWorld),
  );
  assert.ok(
    neutralEmitterNormal.y < -0.9,
    `expected strobe emitters to face downward at neutral tilt, got ${neutralEmitterNormal.y}`,
  );

  updateStrobePanelColors(
    instance,
    new Map([
      ["Tilt Axis", { red: 0, green: 0, blue: 0, intensity: 0, tilt: -0.25 }],
      [
        "Rotation Speed",
        { red: 0, green: 0, blue: 0, intensity: 0, tiltSpeed: 0 },
      ],
    ]),
  );
  const tiltedPositions = emitters.map((mesh) =>
    new Vector3().setFromMatrixPosition(mesh.matrixWorld),
  );
  assert.ok(
    instance.strobePanelData.panelGroup.rotation.x < neutralRotation,
    "expected negative strobe tilt to rotate below the neutral angle",
  );
  approx(
    instance.strobePanelData.panelGroup.rotation.x,
    MathUtils.degToRad(-157.5),
  );

  for (let index = 0; index < emitters.length; index++) {
    assert.ok(
      neutralPositions[index].distanceTo(tiltedPositions[index]) > 1e-6,
      `expected emitter ${index} world matrix to follow panel tilt`,
    );
  }
});

test("white-only visualizer DMX contributes visible intensity", () => {
  const whiteElement = element("Strobe Dimmer 1", ["White"]);
  const dmx = extractElementDmxData({ White: 255 }, whiteElement);

  assert.equal(dmx.white, 1);
  assert.equal(dmx.intensity, 1);
  assert.equal(dmx.red, 1);
  assert.equal(dmx.green, 1);
  assert.equal(dmx.blue, 1);
});

/** Verifies logical Intensity output controls virtual white segment brightness. */
test("virtual white visualizer DMX honors logical zero intensity", () => {
  const whiteElement = element("White Segment 1", [
    "VirtualIntensity",
    "White",
  ]);
  const dmx = extractElementDmxData({ Intensity: 0, White: 255 }, whiteElement);

  assert.equal(dmx.VirtualIntensity, 0);
  assert.equal(dmx.white, 1);
  assert.equal(dmx.intensity, 0);
  assert.equal(dmx.red, 1);
  assert.equal(dmx.green, 1);
  assert.equal(dmx.blue, 1);
});

/** Verifies virtual-dimmer white segments do not infer intensity from white alone. */
test("virtual white visualizer DMX stays dark without intensity output", () => {
  const whiteElement = element("White Segment 1", [
    "VirtualIntensity",
    "White",
  ]);
  const dmx = extractElementDmxData({ White: 255 }, whiteElement);

  assert.equal(dmx.VirtualIntensity, undefined);
  assert.equal(dmx.white, 1);
  assert.equal(dmx.intensity, 0);
  assert.equal(dmx.red, 1);
  assert.equal(dmx.green, 1);
  assert.equal(dmx.blue, 1);
});

/** Verifies a spot fixture with no additive RGB output still renders an open beam. */
test("moving head spot uses white beam when intensity has no RGB output", () => {
  const spotElement: FixtureElement = {
    label: "Head",
    parameters: [parameter("Intensity"), customParameter("Color Wheel")],
  };
  const instance = buildMovingHeadFixture("fixture-generic-spot-white", [
    spotElement,
  ]);
  const dmx = extractElementDmxData(
    { Intensity: 255 },
    spotElement,
  ) as MovingHeadTestDmx;

  updateMovingHeadColors(instance, new Map([["Head", dmx]]));

  const lensMesh = instance.emitters.get("MainEmitter")?.mesh;
  assert.ok(lensMesh, "expected moving-head main emitter mesh");
  const lensMaterial = (
    lensMesh as unknown as {
      material: MeshBasicMaterial;
    }
  ).material;
  assert.equal(instance.movingHeadData.beamMesh.visible, true);
  assert.ok(
    lensMaterial.color.r > 0.9 &&
      lensMaterial.color.g > 0.9 &&
      lensMaterial.color.b > 0.9,
    `expected intensity-only spot beam to render white, got ${lensMaterial.color.r},${lensMaterial.color.g},${lensMaterial.color.b}`,
  );
});

/** Verifies the Generic spot color wheel red slot drives the moving-head beam color. */
test("moving head spot decodes Generic color wheel red", () => {
  const spotElement: FixtureElement = {
    label: "Head",
    parameters: [parameter("Intensity"), customParameter("Color Wheel")],
  };
  const instance = buildMovingHeadFixture("fixture-generic-spot-red", [
    spotElement,
  ]);
  const dmx = extractElementDmxData(
    { Intensity: 255, "Color Wheel": 8 },
    spotElement,
  ) as MovingHeadTestDmx;

  updateMovingHeadColors(instance, new Map([["Head", dmx]]));

  const lensMesh = instance.emitters.get("MainEmitter")?.mesh;
  assert.ok(lensMesh, "expected moving-head main emitter mesh");
  const lensMaterial = (
    lensMesh as unknown as {
      material: MeshBasicMaterial;
    }
  ).material;
  assert.equal(instance.movingHeadData.beamMesh.visible, true);
  assert.ok(
    lensMaterial.color.r > 0.9 &&
      lensMaterial.color.g < 0.01 &&
      lensMaterial.color.b < 0.01,
    `expected color-wheel red spot beam, got ${lensMaterial.color.r},${lensMaterial.color.g},${lensMaterial.color.b}`,
  );
});

/** Verifies Generic half-color wheel slots split the beam instead of mixing RGB. */
test("moving head spot decodes Generic color wheel split colors", () => {
  const spotElement: FixtureElement = {
    label: "Head",
    parameters: [parameter("Intensity"), customParameter("Color Wheel")],
  };
  const instance = buildMovingHeadFixture("fixture-generic-spot-split", [
    spotElement,
  ]);
  const dmx = extractElementDmxData(
    { Intensity: 255, "Color Wheel": 100 },
    spotElement,
  ) as MovingHeadTestDmx;

  updateMovingHeadColors(instance, new Map([["Head", dmx]]));

  const material = instance.movingHeadData.beamMaterial;
  assert.equal(instance.movingHeadData.beamMesh.visible, true);
  if (isLowQualityBeamMaterial(material)) {
    assert.fail("expected high-quality beam material");
  }
  assert.equal(material.forceSinglePass, true);
  assert.equal(material.splitColorAmountUniform.value, 1);
  assert.ok(
    material.beamColorUniform.value.x > 0.9 &&
      material.beamColorUniform.value.y > 0.9 &&
      material.beamColorUniform.value.z > 0.9,
    `expected primary split color to remain white, got ${material.beamColorUniform.value.x},${material.beamColorUniform.value.y},${material.beamColorUniform.value.z}`,
  );
  assert.ok(
    material.secondaryBeamColorUniform.value.x < 0.01 &&
      material.secondaryBeamColorUniform.value.y > 0.9 &&
      material.secondaryBeamColorUniform.value.z < 0.01,
    `expected secondary split color to remain green, got ${material.secondaryBeamColorUniform.value.x},${material.secondaryBeamColorUniform.value.y},${material.secondaryBeamColorUniform.value.z}`,
  );
});

/** Builds pan and tilt joints on identity-transform nodes without element bindings. */
function unboundPanTiltJoints() {
  const panNode = new Group();
  const tiltNode = new Group();
  const geometry: FixtureGeometry = {
    nodes: [
      {
        name: "PanAxis",
        geometryType: GeometryType.Axis,
        transform: identityTransform(),
        axis: AxisType.Pan,
        parentIndex: -1,
      },
      {
        name: "TiltAxis",
        geometryType: GeometryType.Axis,
        transform: identityTransform(),
        axis: AxisType.Tilt,
        parentIndex: 0,
      },
    ],
    roots: [0],
  };
  const joints = createGdtfJoints(
    new Map([
      ["PanAxis", panNode],
      ["TiltAxis", tiltNode],
    ]),
    geometry,
  );
  return { panNode, tiltNode, joints };
}

/** Verifies zero pan/tilt leaves unbound joints at their neutral pose. */
test("GDTF pan/tilt zero keeps articulated nodes at their neutral pose", () => {
  const { panNode, tiltNode, joints } = unboundPanTiltJoints();

  updateGdtfJoints(joints, new Map([["Head", { pan: 0, tilt: 0 }]]), 0, null);

  approx(panNode.quaternion.angleTo(new Quaternion()), 0);
  approx(tiltNode.quaternion.angleTo(new Quaternion()), 0);
});

/** Verifies unbound joints fall back to fixture-wide values, rotating pan about Z and tilt about X. */
test("GDTF pan/tilt values rotate axis nodes from the zero reference", () => {
  const { panNode, tiltNode, joints } = unboundPanTiltJoints();

  updateGdtfJoints(
    joints,
    new Map([["Head", { pan: -135 / 540, tilt: 60 / 270 }]]),
    0,
    null,
  );

  approx(
    panNode.quaternion.angleTo(
      new Quaternion().setFromAxisAngle(
        new Vector3(0, 0, 1),
        MathUtils.degToRad(-135),
      ),
    ),
    0,
  );
  approx(
    tiltNode.quaternion.angleTo(
      new Quaternion().setFromAxisAngle(
        new Vector3(1, 0, 0),
        MathUtils.degToRad(60),
      ),
    ),
    0,
  );
});

/** Ensures rendering depends on explicit layout rather than editable manufacturer/model names. */
test("explicit layouts select renderers without fixture names", () => {
  assert.equal(
    detectRendererType(FixtureLayout.RotatingWashBeam),
    "rotating-wash-beam",
  );
  assert.equal(detectRendererType(FixtureLayout.RgbStrobeBar), "strobe-panel");
  assert.equal(detectRendererType(undefined), "gdtf");
  const instance = buildRotatingWashBeamFixture(
    "linear-wash",
    rotatingWashBeamElements().slice(0, 11),
    "low",
    10,
  );
  assert.equal(instance.rotatingWashBeamData.beamEmitters.length, 10);
  assert.equal(instance.rotatingWashBeamData.stripPixelMeshes.length, 0);
  disposeRotatingWashBeam(instance);
});

/** Ensures editing layout rebuilds a fixture once, while renaming preserves its renderer. */
test("fixture manager rebuilds changed layouts and preserves renamed layouts", () => {
  const manager = new FixtureManager(new Scene(), "low");
  const fixture: RenderableFixture = {
    uid: "editable-layout",
    fixtureId: 1,
    make: "Generic",
    model: "Wash",
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    elements: rotatingWashBeamElements(),
    layout: FixtureLayout.RotatingWashBeam,
  };
  manager.syncFixtures([fixture]);
  const original = manager.getFixtureInstance(fixture.uid);
  manager.syncFixtures([
    { ...fixture, make: "Renamed", model: "Custom label" },
  ]);
  assert.equal(manager.getFixtureInstance(fixture.uid), original);
  const updated = {
    ...fixture,
    elements: fixture.elements.slice(0, 11),
    layout: FixtureLayout.LinearWashBar,
  };
  manager.syncFixtures([updated]);
  const rebuilt = manager.getFixtureInstance(fixture.uid);
  assert.notEqual(rebuilt, original);
  assert.equal(rebuilt?.rotatingWashBeamData?.beamEmitters.length, 10);
  manager.syncFixtures([updated]);
  assert.equal(manager.getFixtureInstance(fixture.uid), rebuilt);
  manager.syncFixtures([]);
});
