// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Scene environment setup for Visualizer.
 * Creates lights, grid, floor, and axes helpers.
 * Works in both main thread and worker contexts.
 */

import {
  AmbientLight,
  AxesHelper,
  CanvasTexture,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type PerspectiveCamera,
  PlaneGeometry,
  type Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
} from "three/webgpu";

/**
 * References to scene environment objects for later manipulation.
 */
export interface SceneEnvironment {
  ambientLight: AmbientLight;
  directionalLight: DirectionalLight;
  fillLight: DirectionalLight;
  grid: GridHelper;
  axesHelper: AxesHelper;
  floor: Mesh;
  orbitTargetIndicator: Group;
}

/**
 * Configuration options for scene environment.
 */
export interface SceneEnvironmentOptions {
  /** Show grid helper. Default: true */
  showGrid?: boolean;
  /** Show axes helper with labels. Default: true */
  showAxes?: boolean;
  /** Show stage floor. Default: true */
  showFloor?: boolean;
  /** Grid size in world units. Default: 20 */
  gridSize?: number;
  /** Grid divisions. Default: 20 */
  gridDivisions?: number;
  /** Ambient light intensity. Default: 0.6 */
  ambientIntensity?: number;
  /** Directional light intensity. Default: 0.8 */
  directionalIntensity?: number;
  /** Fill light intensity. Default: 0.4 */
  fillIntensity?: number;
  /** Show orbit target indicator. Default: false */
  showOrbitTargetIndicator?: boolean;
}

export const DEFAULT_STAGE_FLOOR_TOP_Y = 0.0;

const DEFAULT_OPTIONS: Required<SceneEnvironmentOptions> = {
  showGrid: true,
  showAxes: true,
  showFloor: true,
  gridSize: 20,
  gridDivisions: 20,
  ambientIntensity: 0.6,
  directionalIntensity: 0.8,
  fillIntensity: 0.4,
  showOrbitTargetIndicator: false,
};

/**
 * Create axis label using Sprite with CanvasTexture.
 * Works in both main thread and worker contexts.
 */
function createAxisLabel(
  text: string,
  position: [number, number, number],
  color: string,
): Sprite {
  const canvas = new OffscreenCanvas(128, 128);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = color;
    ctx.font = "bold 64px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 64, 64);
  }
  const texture = new CanvasTexture(canvas);
  const material = new SpriteMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new Sprite(material);
  sprite.scale.set(0.8, 0.8, 1);
  sprite.position.set(...position);
  sprite.renderOrder = 1000;
  return sprite;
}

function createOrbitTargetIndicator(): Group {
  const indicator = new Group();
  indicator.name = "OrbitTargetIndicator";

  const center = new Mesh(
    new SphereGeometry(0.08, 16, 16),
    new MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  center.name = "OrbitTargetCenter";
  indicator.add(center);

  const axes = new AxesHelper(0.6);
  axes.name = "OrbitTargetAxes";
  indicator.add(axes);

  return indicator;
}

/**
 * Setup scene environment with lights, grid, axes, and floor.
 * Returns references to created objects for inspector controls.
 */
export function createSceneEnvironment(
  scene: Scene,
  options: SceneEnvironmentOptions = {},
): SceneEnvironment {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Ambient light for overall illumination
  const ambientLight = new AmbientLight(0xffffff, opts.ambientIntensity);
  ambientLight.name = "AmbientLight";
  scene.add(ambientLight);

  // Directional light for shadows and depth
  const directionalLight = new DirectionalLight(
    0xffffff,
    opts.directionalIntensity,
  );
  directionalLight.name = "DirectionalLight";
  directionalLight.position.set(5, 10, 5);
  scene.add(directionalLight);

  // Secondary fill light from opposite side
  const fillLight = new DirectionalLight(0xffffff, opts.fillIntensity);
  fillLight.name = "FillLight";
  fillLight.position.set(-5, 8, -5);
  scene.add(fillLight);

  // Grid helper for spatial reference
  const grid = new GridHelper(
    opts.gridSize,
    opts.gridDivisions,
    0x555566,
    0x333344,
  );
  grid.name = "GridHelper";
  grid.position.y = 0.01; // Slight offset to prevent z-fighting with floor
  grid.visible = opts.showGrid;
  scene.add(grid);

  // Axes helper with labels for orientation debugging
  const axesHelper = new AxesHelper(2);
  axesHelper.name = "AxesHelper";
  axesHelper.position.y = 0.02; // Slight offset to prevent z-fighting with grid
  axesHelper.visible = opts.showAxes;
  scene.add(axesHelper);

  // Add axis labels
  axesHelper.add(createAxisLabel("+X", [2.2, 0, 0], "#ff4444"));
  axesHelper.add(createAxisLabel("+Y", [0, 2.2, 0], "#44ff44"));
  axesHelper.add(createAxisLabel("+Z", [0, 0, 2.2], "#4444ff"));

  // Stage floor
  const floorGeometry = new PlaneGeometry(opts.gridSize, opts.gridSize);
  const floorMaterial = new MeshStandardMaterial({
    color: 0x2a2a3a,
    roughness: 0.9,
    metalness: 0.1,
    transparent: true,
    opacity: 1,
    side: DoubleSide,
  });
  const floor = new Mesh(floorGeometry, floorMaterial);
  floor.name = "StageFloor";
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = DEFAULT_STAGE_FLOOR_TOP_Y;
  floor.receiveShadow = true;
  floor.visible = opts.showFloor;
  scene.add(floor);

  const orbitTargetIndicator = createOrbitTargetIndicator();
  orbitTargetIndicator.visible = opts.showOrbitTargetIndicator;
  scene.add(orbitTargetIndicator);

  return {
    ambientLight,
    directionalLight,
    fillLight,
    grid,
    axesHelper,
    floor,
    orbitTargetIndicator,
  };
}

/**
 * Update floor transparency based on camera position.
 * When the camera is below the floor, make the floor transparent
 * so the user can see fixtures and objects above it.
 */
export function updateFloorTransparency(
  environment: SceneEnvironment,
  camera: PerspectiveCamera,
): void {
  const floorMaterial = environment.floor.material as MeshStandardMaterial;
  const cameraY = camera.position.y;
  const floorY = environment.floor.position.y;

  // When camera is below floor level, make floor transparent
  // and render it in the transparent pass so beams remain visible through it.
  // When camera is above the floor, keep it opaque so it renders before beams
  // instead of compositing over them.
  if (cameraY < floorY) {
    floorMaterial.transparent = true;
    floorMaterial.opacity = 0.15;
    floorMaterial.depthWrite = false;
  } else {
    floorMaterial.transparent = false;
    floorMaterial.opacity = 1;
    floorMaterial.depthWrite = true;
  }
}

/**
 * Update orbit target indicator position.
 */
export function updateOrbitTargetIndicator(
  environment: SceneEnvironment,
  _camera: PerspectiveCamera,
  target: { x: number; y: number; z: number },
): void {
  const indicator = environment.orbitTargetIndicator;
  indicator.position.set(target.x, target.y, target.z);
}
