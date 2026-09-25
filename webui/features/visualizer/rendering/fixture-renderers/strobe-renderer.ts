// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Strobe panel fixture renderer for Visualizer.
 * Renders strobe panels with pixel grid and white strobe segments.
 *
 * Strobe panels typically have:
 * - A grid of RGB pixels (e.g., 6 rows x 16 columns = 96 pixels)
 * - A center row of white strobe segments
 * - Tilt movement capability
 */

import {
  BoxGeometry,
  type BufferGeometry,
  type Color,
  Group,
  type Material,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from "three/webgpu";
import type { FixtureElement } from "../../../../types";
import type { EmitterData, FixtureInstance } from "../../model/types";
import { EMITTER_RADIANCE } from "../emitter-radiance";
import {
  createEmitterBatches,
  type EmitterBatch,
  updateEmitterBatches,
} from "./emitter-batches";

/** Strobe panel dimensions (meters) */
const STROBE_PANEL_WIDTH = 0.515;
const STROBE_PANEL_HEIGHT = 0.215;
const STROBE_PIXEL_ROWS = 6;
const STROBE_PIXEL_COLUMNS = 16;
const DEFAULT_STROBE_SEGMENT_COUNT = 16;
const STROBE_BAR_WIDTH = 0.012;
const STROBE_BAR_DEPTH = 0.02;
const STROBE_PIXEL_DEPTH = 0.015;
const STROBE_PIXEL_SPACING_Y = 0.02;
const STROBE_PIXEL_MARGIN_Y = 0.012;
const STROBE_PIXEL_CENTER_GAP = 0.03;
const STROBE_ARM_WIDTH = 0.07;
const STROBE_ARM_HEIGHT = STROBE_PANEL_HEIGHT + 0.2;
const STROBE_ARM_DEPTH = 0.12;
const STROBE_ARM_SIDE_GAP = 0.02;
const STROBE_BASE_HEIGHT = 0.05;
const INCH_TO_METER = 0.0254;
const RGB_STROBE_BAR_SEGMENT_COUNT = 24;
const RGB_STROBE_BAR_WIDTH = 1.0;
const RGB_STROBE_BAR_BEZEL = 0.5 * INCH_TO_METER;
const RGB_STROBE_BAR_LED_WIDTH =
  RGB_STROBE_BAR_WIDTH - RGB_STROBE_BAR_BEZEL * 2;
const RGB_STROBE_BAR_LED_HEIGHT = 2 * INCH_TO_METER;
const RGB_STROBE_BAR_HEIGHT =
  RGB_STROBE_BAR_LED_HEIGHT + RGB_STROBE_BAR_BEZEL * 2;
const RGB_STROBE_BAR_DEPTH = 3 * INCH_TO_METER;
const RGB_STROBE_BAR_EMITTER_DEPTH = 0.006;
const STROBE_TILT_RANGE_DEGREES = 270;
const STROBE_TILT_UP_REFERENCE_DEGREES = -90;
const DEFAULT_TILT_SPEED_DEG_PER_SEC = 180;
const MAX_TILT_SPEED_DEG_PER_SEC = 720;

/**
 * Strobe panel specific data stored on the fixture instance.
 */
export interface StrobePanelData {
  type: "strobe-panel";
  layout: "matrix" | "rgb-strobe-bar";
  panelGroup: Group;
  pixelMeshes: Mesh[];
  whiteSegmentMeshes: Mesh[];
  /** Shared draws retain independent source meshes for optical state and element outlines. */
  emitterBatches: EmitterBatch[];
  /** Element labels for DMX lookup (index -> label) */
  elementLabels: string[];
  pixelElementLabels: string[];
  whiteSegmentElementLabels: string[];
  controlElementLabel?: string;
  currentTilt: number;
  targetTilt: number;
  lastUpdateTime: number;
}

type StrobePanelElementMapping = {
  pixelElementLabels: string[];
  whiteSegmentElementLabels: string[];
  controlElementLabel?: string;
};

function elementHasAttribute(
  element: FixtureElement,
  attributeType: string,
): boolean {
  return element.parameters.some(
    (parameter) => parameter.attribute.type === attributeType,
  );
}

function resolveStrobePanelElementMapping(
  elements: FixtureElement[],
): StrobePanelElementMapping {
  const elementLabels = elements.map((element) => element.label);
  const pixelElementLabels = elements
    .filter(
      (element) =>
        elementHasAttribute(element, "Red") &&
        elementHasAttribute(element, "Green") &&
        elementHasAttribute(element, "Blue"),
    )
    .map((element) => element.label);
  const whiteSegmentElementLabels = elements
    .filter(
      (element) =>
        elementHasAttribute(element, "White") &&
        !elementHasAttribute(element, "Red") &&
        !elementHasAttribute(element, "Green") &&
        !elementHasAttribute(element, "Blue"),
    )
    .map((element) => element.label);
  const controlElementLabel = elements.find((element) =>
    elementHasAttribute(element, "Tilt"),
  )?.label;

  if (pixelElementLabels.length > 0 || whiteSegmentElementLabels.length > 0) {
    return {
      pixelElementLabels,
      whiteSegmentElementLabels,
      controlElementLabel,
    };
  }

  return {
    pixelElementLabels: elementLabels.slice(
      0,
      STROBE_PIXEL_ROWS * STROBE_PIXEL_COLUMNS,
    ),
    whiteSegmentElementLabels: elementLabels.slice(
      STROBE_PIXEL_ROWS * STROBE_PIXEL_COLUMNS,
      STROBE_PIXEL_ROWS * STROBE_PIXEL_COLUMNS + DEFAULT_STROBE_SEGMENT_COUNT,
    ),
    controlElementLabel:
      elementLabels[
        STROBE_PIXEL_ROWS * STROBE_PIXEL_COLUMNS + DEFAULT_STROBE_SEGMENT_COUNT
      ],
  };
}

function createStrobeArm(side: "left" | "right"): Mesh {
  const armGeometry = new BoxGeometry(
    STROBE_ARM_WIDTH,
    STROBE_ARM_HEIGHT,
    STROBE_ARM_DEPTH,
  );
  const armMaterial = new MeshStandardMaterial({
    color: 0x0b0b0b,
    metalness: 0.6,
    roughness: 0.4,
  });
  const arm = new Mesh(armGeometry, armMaterial);
  arm.name = side === "left" ? "LeftArm" : "RightArm";
  const offset =
    STROBE_PANEL_WIDTH / 2 + STROBE_ARM_WIDTH / 2 + STROBE_ARM_SIDE_GAP;
  arm.position.set(
    side === "left" ? -offset : offset,
    STROBE_ARM_HEIGHT / 2,
    -0.02,
  );
  return arm;
}

function createStrobeBase(): Mesh {
  const baseWidth =
    STROBE_PANEL_WIDTH + STROBE_ARM_WIDTH * 2 + STROBE_ARM_SIDE_GAP * 2;
  const baseGeometry = new BoxGeometry(
    baseWidth,
    STROBE_BASE_HEIGHT,
    STROBE_ARM_DEPTH,
  );
  const baseMaterial = new MeshStandardMaterial({
    color: 0x0b0b0b,
    metalness: 0.6,
    roughness: 0.4,
  });
  const base = new Mesh(baseGeometry, baseMaterial);
  base.name = "Base";
  base.position.set(0, 0, -0.02);
  return base;
}

function createStrobeFace(): Mesh {
  const faceGeometry = new BoxGeometry(
    STROBE_PANEL_WIDTH + 0.02,
    STROBE_PANEL_HEIGHT + 0.02,
    0.01,
  );
  const faceMaterial = new MeshStandardMaterial({
    color: 0x141414,
    metalness: 0.3,
    roughness: 0.6,
  });
  const face = new Mesh(faceGeometry, faceMaterial);
  face.name = "Face";
  face.position.z = 0.01;
  return face;
}

function createPixelMesh(x: number, y: number): Mesh {
  const size = (STROBE_PANEL_WIDTH / STROBE_PIXEL_COLUMNS) * 0.7;
  const geometry = new BoxGeometry(size, size, STROBE_PIXEL_DEPTH);
  const material = new MeshBasicMaterial({
    color: 0x000000,
    transparent: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = "Pixel";
  mesh.position.set(x, y, STROBE_PIXEL_DEPTH);
  return mesh;
}

function createWhiteSegmentMesh(x: number, width: number): Mesh {
  const geometry = new BoxGeometry(width, STROBE_BAR_WIDTH, STROBE_BAR_DEPTH);
  const material = new MeshBasicMaterial({
    color: 0x000000,
    transparent: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = "WhiteSegment";
  mesh.position.set(x, 0, STROBE_PIXEL_DEPTH * 1.5 + 0.01);
  return mesh;
}

function createRgbStrobeBarSegmentMesh(
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Mesh {
  const geometry = new BoxGeometry(width, height, RGB_STROBE_BAR_EMITTER_DEPTH);
  const material = new MeshBasicMaterial({
    color: 0x000000,
    transparent: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.position.set(
    x,
    y,
    RGB_STROBE_BAR_DEPTH / 2 + RGB_STROBE_BAR_EMITTER_DEPTH / 2,
  );
  return mesh;
}

/**
 * Build a strobe panel fixture.
 * Creates a hardcoded strobe panel layout (doesn't use GDTF geometry).
 * `displayGain` scales the batched emitter faces for the active quality preset.
 */
export function buildStrobePanelFixture(
  fixtureUid: string,
  elements: FixtureElement[],
  displayGain = 1,
): FixtureInstance & { strobePanelData: StrobePanelData } {
  const group = new Group();
  group.name = `Fixture_${fixtureUid}`;

  const modelGroup = new Group();
  modelGroup.name = "Model";
  modelGroup.rotation.x = Math.PI;
  group.add(modelGroup);

  const panelGroup = new Group();
  const face = createStrobeFace();
  const leftArm = createStrobeArm("left");
  const rightArm = createStrobeArm("right");
  const base = createStrobeBase();

  panelGroup.position.y = STROBE_ARM_HEIGHT;

  modelGroup.add(leftArm);
  modelGroup.add(rightArm);
  modelGroup.add(base);
  panelGroup.add(face);
  modelGroup.add(panelGroup);

  // Create pixel grid
  const pixelMeshes: Mesh[] = [];
  const columnSpacing = STROBE_PANEL_WIDTH / STROBE_PIXEL_COLUMNS;
  const startX = -STROBE_PANEL_WIDTH / 2 + columnSpacing / 2;
  const pixelSpanHeight = STROBE_PANEL_HEIGHT - STROBE_PIXEL_MARGIN_Y * 2;
  const rowSpacing = Math.max(
    STROBE_PIXEL_SPACING_Y,
    (pixelSpanHeight - STROBE_PIXEL_CENTER_GAP) / (STROBE_PIXEL_ROWS - 1),
  );
  const startY =
    (rowSpacing * (STROBE_PIXEL_ROWS - 1)) / 2 + STROBE_PIXEL_CENTER_GAP / 2;

  for (let row = 0; row < STROBE_PIXEL_ROWS; row++) {
    let rowY = startY - row * rowSpacing;
    if (row >= STROBE_PIXEL_ROWS / 2) {
      rowY -= STROBE_PIXEL_CENTER_GAP;
    }
    for (let col = 0; col < STROBE_PIXEL_COLUMNS; col++) {
      const mesh = createPixelMesh(startX + col * columnSpacing, rowY);
      panelGroup.add(mesh);
      pixelMeshes.push(mesh);
    }
  }

  const elementLabels = elements.map((e) => e.label);
  const { pixelElementLabels, whiteSegmentElementLabels, controlElementLabel } =
    resolveStrobePanelElementMapping(elements);

  // Create white strobe segments
  const whiteSegmentMeshes: Mesh[] = [];
  const whiteSegmentCount =
    whiteSegmentElementLabels.length || DEFAULT_STROBE_SEGMENT_COUNT;
  const totalBarWidth = STROBE_PANEL_WIDTH - 0.02;
  const gap = 0.006;
  const segmentWidth =
    (totalBarWidth - gap * (whiteSegmentCount - 1)) / whiteSegmentCount;
  const currentX = -totalBarWidth / 2 + segmentWidth / 2;

  for (let i = 0; i < whiteSegmentCount; i++) {
    const mesh = createWhiteSegmentMesh(
      currentX + i * (segmentWidth + gap),
      segmentWidth,
    );
    panelGroup.add(mesh);
    whiteSegmentMeshes.push(mesh);
  }

  // Create emitters map for debug overlay support
  // Add all pixel and white segment meshes as emitters
  const emitters = new Map<string, EmitterData>();

  // Add pixel meshes as emitters (elements 0-95)
  for (let i = 0; i < pixelMeshes.length; i++) {
    const label = pixelElementLabels[i] ?? elementLabels[i] ?? String(i);
    emitters.set(`Pixel_${i}`, {
      mesh: pixelMeshes[i],
      controlledElement: label,
    });
  }

  // Add white segment meshes as emitters (elements 96-111)
  for (let i = 0; i < whiteSegmentMeshes.length; i++) {
    const elementIndex = 96 + i;
    const label =
      whiteSegmentElementLabels[i] ??
      elementLabels[elementIndex] ??
      String(elementIndex);
    emitters.set(`WhiteSegment_${i}`, {
      mesh: whiteSegmentMeshes[i],
      controlledElement: label,
    });
  }

  return {
    uid: fixtureUid,
    group,
    nodeObjects: new Map(),
    emitters,
    strobePanelData: {
      type: "strobe-panel",
      layout: "matrix",
      emitterBatches: createEmitterBatches(
        panelGroup,
        [pixelMeshes, whiteSegmentMeshes],
        displayGain,
      ),
      panelGroup,
      pixelMeshes,
      whiteSegmentMeshes,
      elementLabels,
      pixelElementLabels,
      whiteSegmentElementLabels,
      controlElementLabel,
      currentTilt: 0,
      targetTilt: 0,
      lastUpdateTime: 0,
    },
  };
}

/**
 * Build an RGB strobe bar with its pixel row above independently controlled white segments.
 * `displayGain` scales the batched emitter faces for the active quality preset.
 */
export function buildRgbStrobeBarFixture(
  fixtureUid: string,
  elements: FixtureElement[],
  displayGain = 1,
): FixtureInstance & { strobePanelData: StrobePanelData } {
  const group = new Group();
  group.name = `Fixture_${fixtureUid}`;

  const panelGroup = new Group();
  group.add(panelGroup);

  const housingGeometry = new BoxGeometry(
    RGB_STROBE_BAR_WIDTH,
    RGB_STROBE_BAR_HEIGHT,
    RGB_STROBE_BAR_DEPTH,
  );
  const housingMaterial = new MeshStandardMaterial({
    color: 0x141414,
    metalness: 0.45,
    roughness: 0.45,
  });
  const housing = new Mesh(housingGeometry, housingMaterial);
  housing.name = "Housing";
  housing.position.z = 0;
  panelGroup.add(housing);

  const segmentSpacing =
    RGB_STROBE_BAR_LED_WIDTH / RGB_STROBE_BAR_SEGMENT_COUNT;
  const segmentWidth = segmentSpacing * 0.82;
  const rgbSegmentHeight = segmentWidth * (2 / 5);
  const whiteSegmentHeight = segmentWidth * (1 / 5);
  const rowGap =
    (RGB_STROBE_BAR_LED_HEIGHT - rgbSegmentHeight * 2 - whiteSegmentHeight) / 2;
  const rgbRowY = whiteSegmentHeight / 2 + rowGap + rgbSegmentHeight / 2;
  const pixelMeshes: Mesh[] = [];
  const whiteSegmentMeshes: Mesh[] = [];

  for (let i = 0; i < RGB_STROBE_BAR_SEGMENT_COUNT; i++) {
    const x =
      -RGB_STROBE_BAR_LED_WIDTH / 2 + segmentSpacing / 2 + i * segmentSpacing;
    const topMesh = createRgbStrobeBarSegmentMesh(
      "TopRgbSegment",
      x,
      rgbRowY,
      segmentWidth,
      rgbSegmentHeight,
    );
    panelGroup.add(topMesh);
    pixelMeshes.push(topMesh);
  }

  for (let i = 0; i < RGB_STROBE_BAR_SEGMENT_COUNT; i++) {
    const x =
      -RGB_STROBE_BAR_LED_WIDTH / 2 + segmentSpacing / 2 + i * segmentSpacing;
    const whiteMesh = createRgbStrobeBarSegmentMesh(
      "WhiteSegment",
      x,
      0,
      segmentWidth,
      whiteSegmentHeight,
    );
    panelGroup.add(whiteMesh);
    whiteSegmentMeshes.push(whiteMesh);
  }

  for (let i = 0; i < RGB_STROBE_BAR_SEGMENT_COUNT; i++) {
    const x =
      -RGB_STROBE_BAR_LED_WIDTH / 2 + segmentSpacing / 2 + i * segmentSpacing;
    const bottomMesh = createRgbStrobeBarSegmentMesh(
      "BottomRgbSegment",
      x,
      -rgbRowY,
      segmentWidth,
      rgbSegmentHeight,
    );
    panelGroup.add(bottomMesh);
    pixelMeshes.push(bottomMesh);
  }

  const elementLabels = elements.map((e) => e.label);
  const { pixelElementLabels, whiteSegmentElementLabels, controlElementLabel } =
    resolveStrobePanelElementMapping(elements);

  const emitters = new Map<string, EmitterData>();

  for (let i = 0; i < whiteSegmentMeshes.length; i++) {
    const label = whiteSegmentElementLabels[i] ?? elementLabels[i] ?? String(i);
    emitters.set(`WhiteSegment_${i}`, {
      mesh: whiteSegmentMeshes[i],
      controlledElement: label,
    });
  }

  for (let i = 0; i < pixelMeshes.length; i++) {
    const elementIndex = RGB_STROBE_BAR_SEGMENT_COUNT + i;
    const label =
      pixelElementLabels[i] ??
      elementLabels[elementIndex] ??
      String(elementIndex);
    emitters.set(`RgbSegment_${i}`, {
      mesh: pixelMeshes[i],
      controlledElement: label,
    });
  }

  return {
    uid: fixtureUid,
    group,
    nodeObjects: new Map(),
    emitters,
    strobePanelData: {
      type: "strobe-panel",
      layout: "rgb-strobe-bar",
      emitterBatches: createEmitterBatches(
        panelGroup,
        [pixelMeshes, whiteSegmentMeshes],
        displayGain,
      ),
      panelGroup,
      pixelMeshes,
      whiteSegmentMeshes,
      elementLabels,
      pixelElementLabels,
      whiteSegmentElementLabels,
      controlElementLabel,
      currentTilt: 0,
      targetTilt: 0,
      lastUpdateTime: 0,
    },
  };
}

/** Applies display gain in place without allocating a color for each emitter on every update. */
function boostColor(baseColor: Color, intensity: number): Color {
  return baseColor.multiplyScalar(intensity * EMITTER_RADIANCE);
}

/** Resolves independent RGB cell output into its persistent linear material color. */
function updateRgbEmitterMesh(
  mesh: Mesh,
  dmx:
    | {
        red: number;
        green: number;
        blue: number;
        intensity: number;
      }
    | undefined,
): void {
  const material = mesh.material as MeshBasicMaterial;

  if (!dmx) {
    material.color.setRGB(0, 0, 0);
    return;
  }

  const baseColor = material.color.setRGB(dmx.red, dmx.green, dmx.blue);
  baseColor.convertSRGBToLinear();
  boostColor(baseColor, dmx.intensity);
}

/** Resolves a white cell without allocating temporary colors or retaining stale output after blackout. */
function updateWhiteEmitterMesh(
  mesh: Mesh,
  dmx:
    | {
        intensity: number;
        white?: number;
      }
    | undefined,
): void {
  const material = mesh.material as MeshBasicMaterial;

  if (!dmx) {
    material.color.setRGB(0, 0, 0);
    return;
  }

  const level = dmx.white ?? dmx.intensity;
  const whiteColor = material.color.setRGB(level, level, level);
  whiteColor.convertSRGBToLinear();
  boostColor(whiteColor, dmx.intensity);
}

/**
 * Default DMX values when no data is available.
 */
const DEFAULT_DMX = {
  red: 0,
  green: 0,
  blue: 0,
  intensity: 0,
  tilt: 0,
};

/**
 * Update strobe panel from DMX data.
 *
 * Element roles are derived from fixture attributes so DMX channel order can
 * match the physical profile.
 *
 * @param elementColors Map with element labels as keys
 */
export function updateStrobePanelColors(
  instance: FixtureInstance & { strobePanelData: StrobePanelData },
  elementColors: Map<
    string,
    {
      red: number;
      green: number;
      blue: number;
      intensity: number;
      white?: number;
      tilt?: number;
      tiltSpeed?: number;
    }
  >,
): void {
  const data = instance.strobePanelData;
  const {
    panelGroup,
    layout,
    pixelMeshes,
    whiteSegmentMeshes,
    elementLabels,
    pixelElementLabels,
    whiteSegmentElementLabels,
    controlElementLabel,
  } = data;

  if (layout === "rgb-strobe-bar") {
    for (let i = 0; i < whiteSegmentMeshes.length; i++) {
      const label = whiteSegmentElementLabels[i] ?? elementLabels[i];
      const dmx =
        (label ? elementColors.get(label) : undefined) ??
        elementColors.get(String(i));
      updateWhiteEmitterMesh(whiteSegmentMeshes[i], dmx);
    }

    for (let i = 0; i < pixelMeshes.length; i++) {
      const elementIndex = RGB_STROBE_BAR_SEGMENT_COUNT + i;
      const label = pixelElementLabels[i] ?? elementLabels[elementIndex];
      const dmx =
        (label ? elementColors.get(label) : undefined) ??
        elementColors.get(String(elementIndex));
      updateRgbEmitterMesh(pixelMeshes[i], dmx);
    }

    updateEmitterBatches(data);
    return;
  }

  // Layout constants
  const PIXEL_COUNT = 96;
  const DIMMER_COUNT =
    whiteSegmentElementLabels.length || whiteSegmentMeshes.length;
  const PIXEL_OFFSET = 0;
  const DIMMER_OFFSET = PIXEL_OFFSET + PIXEL_COUNT;
  const CONTROL_OFFSET = DIMMER_OFFSET + DIMMER_COUNT;

  // Get tilt from control element
  const controlLabel = controlElementLabel ?? elementLabels[CONTROL_OFFSET];
  const controlDmx = controlLabel ? elementColors.get(controlLabel) : undefined;
  const tilt = controlDmx?.tilt ?? DEFAULT_DMX.tilt;
  const rotationSpeedDmx = elementColors.get("Rotation Speed");

  // Apply tilt rotation
  const tiltDegrees =
    STROBE_TILT_UP_REFERENCE_DEGREES + tilt * STROBE_TILT_RANGE_DEGREES;
  data.targetTilt = MathUtils.degToRad(tiltDegrees);
  const now = performance.now();
  const deltaSeconds =
    data.lastUpdateTime === 0
      ? 0
      : Math.max(0, (now - data.lastUpdateTime) / 1000);
  data.lastUpdateTime = now;

  if (deltaSeconds > 0) {
    const speed =
      rotationSpeedDmx?.tiltSpeed === undefined
        ? DEFAULT_TILT_SPEED_DEG_PER_SEC
        : MathUtils.lerp(
            DEFAULT_TILT_SPEED_DEG_PER_SEC,
            MAX_TILT_SPEED_DEG_PER_SEC,
            MathUtils.clamp(rotationSpeedDmx.tiltSpeed, 0, 1),
          );
    const maxStep = MathUtils.degToRad(speed * deltaSeconds);
    const tiltDelta = data.targetTilt - data.currentTilt;
    data.currentTilt += MathUtils.clamp(tiltDelta, -maxStep, maxStep);
  } else {
    data.currentTilt = data.targetTilt;
  }

  panelGroup.rotation.x = data.currentTilt;
  panelGroup.updateMatrixWorld(true);

  // Update pixel colors
  for (let i = 0; i < pixelMeshes.length; i++) {
    const elementIndex = PIXEL_OFFSET + i;
    const label = pixelElementLabels[i] ?? elementLabels[elementIndex];
    const dmx =
      (label ? elementColors.get(label) : undefined) ??
      elementColors.get(String(elementIndex));

    if (dmx) {
      updateRgbEmitterMesh(pixelMeshes[i], dmx);
    } else {
      updateRgbEmitterMesh(pixelMeshes[i], undefined);
    }
  }

  // Update white strobe segments
  const segmentsPerDimmer =
    whiteSegmentMeshes.length / Math.max(DIMMER_COUNT, 1);

  for (let i = 0; i < whiteSegmentMeshes.length; i++) {
    const dimmerIndex = Math.min(
      DIMMER_COUNT - 1,
      Math.floor(i / segmentsPerDimmer),
    );
    const elementIndex = DIMMER_OFFSET + dimmerIndex;
    const label =
      whiteSegmentElementLabels[dimmerIndex] ?? elementLabels[elementIndex];
    const dmx =
      (label ? elementColors.get(label) : undefined) ??
      elementColors.get(String(elementIndex));

    if (dmx) {
      updateWhiteEmitterMesh(whiteSegmentMeshes[i], dmx);
    } else {
      updateWhiteEmitterMesh(whiteSegmentMeshes[i], undefined);
    }
  }
  updateEmitterBatches(data);
}

/**
 * Dispose strobe panel resources.
 */
export function disposeStrobePanel(
  instance: FixtureInstance & { strobePanelData: StrobePanelData },
): void {
  for (const { mesh } of instance.strobePanelData.emitterBatches)
    mesh.dispose();
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  instance.group.traverse((child) => {
    if (child instanceof Mesh) {
      geometries.add(child.geometry);
      if (Array.isArray(child.material)) {
        for (const material of child.material) materials.add(material);
      } else if (child.material) {
        materials.add(child.material);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
