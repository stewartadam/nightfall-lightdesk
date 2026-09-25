// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * LED bar fixture renderer for Visualizer.
 * Uses InstancedMesh for efficient rendering of multiple LED cells.
 *
 * LED bars have many individually-controllable LED cells (pixels).
 * This renderer creates a single InstancedMesh with per-instance colors
 * for high performance even with thousands of cells.
 */

import {
  BoxGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from "three/webgpu";
import type {
  FixtureElement,
  FixtureGeometry,
  FixturePhysical,
} from "../../../../types";
import type { EmitterData, FixtureInstance } from "../../model/types";
import { FilteredEmitterRow } from "../effects/filtered-emitter-row";
import { EMITTER_RADIANCE } from "../emitter-radiance";

const LED_BAR_HOUSING_HEIGHT = 0.06;
const LED_BAR_HANGING_HOUSING_Y = -LED_BAR_HOUSING_HEIGHT / 2;
const LED_BAR_CELL_Y = -0.07;

/** Uses a shared filtered surface only when the actual cell positions form a regular straight row. */
function createFilteredRow(
  group: Group,
  cellMesh: InstancedMesh<BoxGeometry>,
  positions: readonly { x: number; y: number; z: number }[],
): FilteredEmitterRow | undefined {
  if (positions.length < 2) return undefined;
  const first = positions[0];
  const spacing = positions[1].x - first.x;
  if (
    spacing <= 0 ||
    positions.some(
      (position, index) =>
        Math.abs(position.x - first.x - index * spacing) > spacing * 0.001 ||
        Math.abs(position.y - first.y) > spacing * 0.001 ||
        Math.abs(position.z - first.z) > spacing * 0.001,
    )
  )
    return undefined;
  const { width, height, depth } = cellMesh.geometry.parameters;
  if (width > spacing) return undefined;
  const row = new FilteredEmitterRow(
    positions.length,
    spacing,
    width,
    height,
    depth,
  );
  row.mesh.position.set(
    (first.x + positions[positions.length - 1].x) / 2,
    first.y,
    first.z,
  );
  group.add(row.mesh);
  // Keep the physical cells for opaque depth and dark lenses; the row supplies their emission.
  (cellMesh.material as MeshBasicMaterial).color.setScalar(0);
  return row;
}

/**
 * LED bar specific data stored on the fixture instance.
 */
export interface LedBarData {
  type: "led-bar";
  cellMesh: InstancedMesh;
  /** Spatially filtered luminous surface for regular rows; original cells retain DMX and selection indexing. */
  filteredRow?: FilteredEmitterRow;
  cellCount: number;
  /** Per-cell proxy meshes used by outline selection passes. */
  cellSelectionMeshes: Mesh[];
  /** Shared invisible material for per-cell outline proxy meshes. */
  cellSelectionMaterial: MeshBasicMaterial;
  /** Maps element label to cell index */
  elementToCellIndex: Map<string, number>;
}

/** Add invisible per-cell meshes so outline passes can target one LED cell. */
function addCellSelectionMeshes(
  group: Group,
  cellGeometry: BoxGeometry,
  cellPositions: readonly Vector3[],
): { cellSelectionMeshes: Mesh[]; cellSelectionMaterial: MeshBasicMaterial } {
  const cellSelectionMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const cellSelectionMeshes = cellPositions.map((position, index) => {
    const mesh = new Mesh(cellGeometry, cellSelectionMaterial);
    mesh.name = `PixelSelection_${index}`;
    mesh.userData.visualizerOutlineOnly = true;
    mesh.visible = false;
    mesh.position.copy(position);
    mesh.raycast = () => {};
    group.add(mesh);
    return mesh;
  });

  return { cellSelectionMeshes, cellSelectionMaterial };
}

/**
 * Build an LED bar fixture from GDTF geometry.
 * Detects beam geometry nodes and creates an instanced mesh for all cells.
 */
export function buildLedBarFixture(
  fixtureUid: string,
  geometry: FixtureGeometry,
): FixtureInstance & { ledBarData: LedBarData } {
  const group = new Group();
  group.name = `Fixture_${fixtureUid}`;

  // Collect all beam nodes (emitters) to determine cell layout
  const beamNodes = geometry.nodes.filter(
    (node) => node.geometryType === "beam" && node.controlledElement,
  );

  const cellCount = beamNodes.length;
  if (cellCount === 0) {
    throw new Error("LED bar fixture has no beam geometry nodes");
  }

  // Calculate bar dimensions from beam positions
  const positions: Vector3[] = [];
  const elementToCellIndex = new Map<string, number>();

  for (let i = 0; i < beamNodes.length; i++) {
    const node = beamNodes[i];
    // Extract position from transform matrix
    const pos = new Vector3();
    const matrix = new Matrix4().fromArray(node.transform.elements);
    pos.setFromMatrixPosition(matrix);
    // Convert from meters to scene units (meters)
    positions.push(pos);

    if (node.controlledElement) {
      elementToCellIndex.set(node.controlledElement, i);
    }
  }

  // Calculate bounding box for bar dimensions
  let minX = Infinity;
  let maxX = -Infinity;
  let avgY = 0;
  let avgZ = 0;

  for (const pos of positions) {
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x);
    avgY += pos.y;
    avgZ += pos.z;
  }
  avgY /= positions.length;
  avgZ /= positions.length;

  const barWidth = maxX - minX + 0.05; // Add padding
  const cellSpacing = barWidth / cellCount;
  const cellWidth = cellSpacing * 0.6;

  // Create bar housing (dark metal frame)
  const housingGeometry = new BoxGeometry(
    barWidth + 0.04,
    LED_BAR_HOUSING_HEIGHT,
    0.04,
  );
  const housingMaterial = new MeshStandardMaterial({
    color: 0x1a1a1a,
    metalness: 0.7,
    roughness: 0.3,
  });
  const housing = new Mesh(housingGeometry, housingMaterial);
  housing.name = "Housing";
  housing.position.set(
    (minX + maxX) / 2,
    avgY + LED_BAR_HANGING_HOUSING_Y,
    avgZ,
  );
  group.add(housing);

  // Create instanced mesh for LED cells
  const cellGeometry = new BoxGeometry(cellWidth, 0.02, 0.03);
  const cellMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: false,
    vertexColors: true,
  });
  const cellMesh = new InstancedMesh(cellGeometry, cellMaterial, cellCount);
  cellMesh.name = "Pixels";

  // Initialize instance colors (black = off)
  cellMesh.instanceColor = new InstancedBufferAttribute(
    new Float32Array(cellCount * 3),
    3,
  );

  // Position each cell instance
  const instanceMatrix = new Matrix4();
  const cellPositions: Vector3[] = [];
  for (let i = 0; i < cellCount; i++) {
    const pos = positions[i];
    const cellPosition = new Vector3(pos.x, pos.y + LED_BAR_CELL_Y, pos.z);
    cellPositions.push(cellPosition);
    instanceMatrix.setPosition(cellPosition.x, cellPosition.y, cellPosition.z);
    cellMesh.setMatrixAt(i, instanceMatrix);
  }
  cellMesh.instanceMatrix.needsUpdate = true;

  group.add(cellMesh);
  const { cellSelectionMeshes, cellSelectionMaterial } = addCellSelectionMeshes(
    group,
    cellGeometry,
    cellPositions,
  );

  const filteredRow = createFilteredRow(group, cellMesh, cellPositions);

  // Scale from GDTF millimeters to scene meters
  group.scale.setScalar(0.001);

  // Create emitter map for DMX updates
  // Each emitter needs its own positioned Object3D so debug overlays can place markers correctly.
  // We create invisible anchor objects at each cell position.
  const emitters = new Map<string, EmitterData>();
  for (let i = 0; i < beamNodes.length; i++) {
    const node = beamNodes[i];
    if (node.controlledElement) {
      // Create an invisible anchor mesh at the cell position for debug overlay support
      const anchor = new Object3D();
      anchor.name = `EmitterAnchor_${node.name}`;
      const pos = positions[i];
      anchor.position.set(pos.x, pos.y + LED_BAR_CELL_Y, pos.z);
      group.add(anchor);

      emitters.set(node.name, {
        mesh: anchor as unknown as Mesh, // Anchor for debug overlays to attach markers
        controlledElement: node.controlledElement,
      });
    }
  }

  return {
    uid: fixtureUid,
    group,
    nodeObjects: new Map(), // LED bars don't use node hierarchy
    emitters,
    ledBarData: {
      type: "led-bar",
      cellMesh,
      filteredRow,
      cellCount,
      cellSelectionMeshes,
      cellSelectionMaterial,
      elementToCellIndex,
    },
  };
}

/**
 * Update LED bar cell colors from DMX data.
 * This is more efficient than updating individual meshes.
 *
 * @param elementColors Map with element labels as keys (e.g., "Pixel 1", "Pixel 2")
 */
export function updateLedBarColors(
  instance: FixtureInstance & { ledBarData: LedBarData },
  elementColors: Map<
    string,
    { red: number; green: number; blue: number; intensity: number }
  >,
): void {
  const { cellMesh, elementToCellIndex } = instance.ledBarData;
  const instanceColor = cellMesh.instanceColor;
  if (!instanceColor) return;

  const color = new Color();

  // Iterate by label - elementColors uses element labels as keys
  for (const [label, dmx] of elementColors) {
    const cellIndex = elementToCellIndex.get(label);
    if (cellIndex === undefined) continue;

    // Apply color with intensity
    // Input DMX color is in sRGB (0..1). Convert to linear for renderer.
    color.setRGB(dmx.red, dmx.green, dmx.blue);
    color.convertSRGBToLinear();

    // Preserve HDR output so saturated cells participate in the shared haze glow.
    color.multiplyScalar(dmx.intensity * EMITTER_RADIANCE);
    instanceColor.setXYZ(cellIndex, color.r, color.g, color.b);
  }

  const { filteredRow } = instance.ledBarData;
  if (filteredRow) filteredRow.update(instanceColor.array);
  else instanceColor.needsUpdate = true;
}

/**
 * Dispose LED bar resources.
 */
export function disposeLedBar(
  instance: FixtureInstance & { ledBarData: LedBarData },
): void {
  const { cellMesh, cellSelectionMaterial } = instance.ledBarData;
  cellMesh.geometry?.dispose();
  (cellMesh.material as MeshBasicMaterial)?.dispose();
  cellSelectionMaterial.dispose();
  instance.ledBarData.filteredRow?.dispose();

  // Dispose housing (first child of group)
  const housing = instance.group.children[0] as Mesh | undefined;
  if (housing) {
    housing.geometry?.dispose();
    (housing.material as MeshStandardMaterial)?.dispose();
  }
}

/**
 * Build an LED bar fixture from element data (no GDTF geometry).
 * Creates a simple linear arrangement of pixels based on element count.
 *
 * This is used for fixtures patched without GDTF data, like generic pixel tapes.
 * `displayGain` scales the luminous cells for the active quality preset.
 */
export function buildSimpleLedBar(
  fixtureUid: string,
  elements: FixtureElement[],
  physical?: FixturePhysical,
  displayGain = 1,
): FixtureInstance & { ledBarData: LedBarData } {
  const group = new Group();
  group.name = `Fixture_${fixtureUid}`;

  const cellCount = elements.length;
  if (cellCount === 0) {
    throw new Error("LED bar fixture has no elements");
  }

  // Build element label to index map
  const elementToCellIndex = new Map<string, number>();
  for (let i = 0; i < elements.length; i++) {
    elementToCellIndex.set(elements[i].label, i);
  }

  // Calculate cell spacing to fit ~1m bar width (same as V1 visualizer)
  const barWidth = 1.0; // 1 meter total width
  const cellSpacing = barWidth / cellCount;
  const cellWidth = cellSpacing * 0.6;

  // Create bar housing (dark metal frame)
  const housingGeometry = new BoxGeometry(
    barWidth + 0.04,
    LED_BAR_HOUSING_HEIGHT,
    0.04,
  );
  const housingMaterial = new MeshStandardMaterial({
    color: 0x1a1a1a,
    metalness: 0.7,
    roughness: 0.3,
  });
  const housing = new Mesh(housingGeometry, housingMaterial);
  housing.name = "Housing";
  housing.position.set(0, LED_BAR_HANGING_HOUSING_Y, 0);
  group.add(housing);

  // Create instanced mesh for LED cells
  const cellGeometry = new BoxGeometry(cellWidth, 0.02, 0.03);
  const cellMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: false,
    vertexColors: true,
  });
  const cellMesh = new InstancedMesh(cellGeometry, cellMaterial, cellCount);
  cellMesh.name = "Pixels";

  // Initialize instance colors (black = off)
  cellMesh.instanceColor = new InstancedBufferAttribute(
    new Float32Array(cellCount * 3),
    3,
  );

  // Position each cell instance in a linear arrangement
  const instanceMatrix = new Matrix4();
  const startX = -barWidth / 2 + cellSpacing / 2;
  const cellPositions: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < cellCount; i++) {
    const x = startX + i * cellSpacing;
    const y = LED_BAR_CELL_Y;
    const z = 0;
    instanceMatrix.setPosition(x, y, z);
    cellMesh.setMatrixAt(i, instanceMatrix);
    cellPositions.push({ x, y, z });
  }
  cellMesh.instanceMatrix.needsUpdate = true;

  group.add(cellMesh);
  const { cellSelectionMeshes, cellSelectionMaterial } = addCellSelectionMeshes(
    group,
    cellGeometry,
    cellPositions.map(
      (position) => new Vector3(position.x, position.y, position.z),
    ),
  );

  // Create emitter map for DMX updates
  // Each emitter needs its own positioned Object3D so debug overlays can place markers correctly.
  const filteredRow = createFilteredRow(group, cellMesh, cellPositions);
  // A filtered row supplies the emission, leaving the physical cells as dark lenses.
  if (filteredRow) filteredRow.mesh.material.color.setScalar(displayGain);
  else cellMaterial.color.setScalar(displayGain);
  const emitters = new Map<string, EmitterData>();
  for (let i = 0; i < elements.length; i++) {
    const pos = cellPositions[i];

    // Create an invisible anchor at the cell position for debug overlay support
    const anchor = new Object3D();
    anchor.name = `EmitterAnchor_${i}`;
    anchor.position.set(pos.x, pos.y, pos.z);
    anchor.rotation.x = -Math.PI / 2;
    group.add(anchor);

    emitters.set(String(i), {
      mesh: anchor as unknown as Mesh,
      nodeGroup: anchor,
      controlledElement: elements[i].label,
      optics: physical
        ? {
            physical: {
              ...physical,
              // Fixture-level flux is shared across independently controlled cells.
              lumens:
                physical.lumens === undefined
                  ? undefined
                  : physical.lumens / cellCount,
            },
            radius: Math.min(cellWidth, 0.03) / 2,
            throwRatio: 1,
            rectangleRatio: 1,
          }
        : undefined,
    });
  }

  return {
    uid: fixtureUid,
    group,
    nodeObjects: new Map(),
    emitters,
    ledBarData: {
      type: "led-bar",
      cellMesh,
      filteredRow,
      cellCount,
      cellSelectionMeshes,
      cellSelectionMaterial,
      elementToCellIndex,
    },
  };
}

/**
 * Check if a fixture without geometry should use simple LED bar renderer.
 * Returns true if the fixture has 8+ RGB/RGBW elements (typical pixel tape).
 */
export function isSimpleLedBar(elements: FixtureElement[]): boolean {
  if (elements.length < 8) return false;

  // Check if most elements have RGB parameters (typical for pixel fixtures)
  let rgbCount = 0;
  for (const element of elements) {
    const hasRgb = element.parameters.some((p) => p.attribute.type === "Red");
    if (hasRgb) rgbCount++;
  }

  // If 80%+ elements have RGB, it's likely a pixel fixture
  return rgbCount >= elements.length * 0.8;
}
