// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Preview the renderer for fixture library preview.
 * A simplified renderer setup for displaying a single fixture in isolation.
 *
 * Design goals:
 * - Reuse core visualizer infrastructure (GeometryBuilder, materials)
 * - Simplified scene (no grid, no floor, ambient light only)
 * - Auto-framing camera based on fixture bounds
 * - Minimal controls (optional rotation)
 * - Static preview (no DMX-driven updates)
 */

import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  AmbientLight,
  Box3,
  DirectionalLight,
  Mesh,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import type { FixtureGeometry } from "../../../types";
import type { RenderableFixture } from "../model/types";
import type { ExtendedFixtureInstance } from "./fixture-renderers";
import {
  buildFixtureWithoutGeometry,
  buildFixtureWithRenderer,
  disposeFixtureWithRenderer,
  updateFixtureColors,
} from "./fixture-renderers";
import { type EmitterColor, updateEmitterColors } from "./geometry-builder";

/** Default camera distance as multiplier of fixture size */
const CAMERA_DISTANCE_FACTOR = 2.5;

/** Default camera angles */
const DEFAULT_AZIMUTH = -Math.PI / 4; // 45 degrees from front-right
const DEFAULT_ELEVATION = -Math.PI / 6; // 30 degrees below horizon (looking upward)
const PREVIEW_EMITTER_COLOR: EmitterColor = {
  red: 1,
  green: 0,
  blue: 0,
  intensity: 1,
};

function colorPreviewEmitters(instance: ExtendedFixtureInstance): void {
  if (instance.emitters.size === 0) return;

  const elementColors = new Map<string, EmitterColor>();
  for (const [, emitter] of instance.emitters) {
    elementColors.set(emitter.controlledElement, PREVIEW_EMITTER_COLOR);
  }
  if (instance.rendererType === "gdtf") {
    updateEmitterColors(instance, elementColors);
  } else {
    updateFixtureColors(instance, elementColors);
  }
}

/**
 * Fixture data needed to build a standalone preview instance.
 */
export interface PreviewFixtureDefinition {
  /** Fixture manufacturer name. */
  make: string;
  /** Fixture model name. */
  model: string;
  /** Optional GDTF geometry for geometry-backed previews. */
  geometry: FixtureGeometry | null;
  /** Fixture elements used by specialized renderers. */
  elements: RenderableFixture["elements"];
  /** Optional beam type for renderer defaults. */
  beamType?: RenderableFixture["beamType"];
  /** Explicit physical layout for built-in fixtures. */
  layout?: RenderableFixture["layout"];
}

/**
 * Preview the renderer state.
 */
export interface PreviewRendererState {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  ambientLight: AmbientLight;
  directionalLight: DirectionalLight;
  fixtureInstance: ExtendedFixtureInstance | null;
  isPaused: boolean;
}

/**
 * Initialize a preview renderer for fixture display.
 */
export function initPreviewRenderer(
  canvas: HTMLCanvasElement,
): PreviewRendererState {
  // Create WebGPU renderer
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x1a1a2e, 1);

  // Create scene
  const scene = new Scene();
  scene.name = "PreviewScene";

  // Create camera with default settings
  const camera = new PerspectiveCamera(
    45, // FOV
    canvas.clientWidth / canvas.clientHeight,
    0.01, // Near plane (close for small fixtures)
    100, // Far plane
  );
  camera.name = "PreviewCamera";

  // Default camera position
  camera.position.set(2, 1.5, 2);

  // Create controls
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.enablePan = false; // Disable pan for simpler preview interaction
  controls.minDistance = 0.1;
  controls.maxDistance = 20;
  controls.target.set(0, 0, 0);
  controls.update();

  // Ambient light - primary illumination for preview
  const ambientLight = new AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);

  // Directional light - subtle directional highlight
  const directionalLight = new DirectionalLight(0xffffff, 0.4);
  directionalLight.position.set(2, 3, 2);
  scene.add(directionalLight);

  return {
    renderer,
    scene,
    camera,
    controls,
    ambientLight,
    directionalLight,
    fixtureInstance: null,
    isPaused: false,
  };
}

/**
 * Set the fixture to display in the preview.
 * Disposes any existing fixture and loads the new one.
 */
export function setPreviewFixture(
  state: PreviewRendererState,
  fixture: PreviewFixtureDefinition | null,
): void {
  // Dispose existing fixture
  if (state.fixtureInstance) {
    state.scene.remove(state.fixtureInstance.group);
    disposeFixtureWithRenderer(state.fixtureInstance);
    state.fixtureInstance = null;
  }

  // Load new fixture if provided
  if (fixture) {
    const instance = fixture.geometry
      ? buildFixtureWithRenderer(
          "preview",
          fixture.geometry,
          fixture.elements,
          fixture.beamType,
          "high",
          fixture.layout,
        )
      : buildFixtureWithoutGeometry(
          "preview",
          fixture.elements,
          fixture.beamType,
          "high",
          fixture.layout,
        );

    if (!instance) return;

    state.fixtureInstance = instance;
    colorPreviewEmitters(instance);
    state.scene.add(instance.group);

    // Frame the camera on the new fixture
    frameCameraOnFixture(state);
  }
}

/**
 * Adjust camera to frame the fixture nicely.
 * Computes bounding box and positions camera to see the full fixture.
 */
function frameCameraOnFixture(state: PreviewRendererState): void {
  if (!state.fixtureInstance) return;

  // Compute bounding box of the fixture
  const box = new Box3().setFromObject(state.fixtureInstance.group);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());

  // Get the largest dimension for distance calculation
  const maxDim = Math.max(size.x, size.y, size.z);
  const distance = maxDim * CAMERA_DISTANCE_FACTOR;

  // Position camera using spherical coordinates
  const x = center.x + distance * Math.sin(DEFAULT_AZIMUTH);
  const y = center.y + distance * Math.sin(DEFAULT_ELEVATION);
  const z = center.z + distance * Math.cos(DEFAULT_AZIMUTH);

  state.camera.position.set(x, y, z);
  state.controls.target.copy(center);
  state.controls.update();
}

/**
 * Handle canvas resize.
 */
export function handlePreviewResize(
  state: PreviewRendererState,
  width: number,
  height: number,
): void {
  if (width <= 0 || height <= 0) return;
  state.camera.aspect = width / height;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(width, height, false);
}

/**
 * Start the preview render loop.
 */
export function startPreviewRenderLoop(state: PreviewRendererState): void {
  state.isPaused = false;

  state.renderer.setAnimationLoop(() => {
    if (state.isPaused) return;

    // Skip rendering when the canvas has no area (e.g. tab not visible)
    const { width, height } = state.renderer.getSize(new Vector2());
    if (width <= 0 || height <= 0) return;

    state.controls.update();
    state.renderer.renderAsync(state.scene, state.camera);
  });
}

/**
 * Stop the preview render loop.
 */
function stopPreviewRenderLoop(state: PreviewRendererState): void {
  state.isPaused = true;
  state.renderer.setAnimationLoop(null);
}

/**
 * Dispose the all preview renderer resources.
 */
export function disposePreviewRenderer(state: PreviewRendererState): void {
  stopPreviewRenderLoop(state);

  // Dispose fixture
  if (state.fixtureInstance) {
    state.scene.remove(state.fixtureInstance.group);
    disposeFixtureWithRenderer(state.fixtureInstance);
  }

  // Dispose controls
  state.controls.dispose();

  // Dispose scene objects
  state.scene.traverse((object) => {
    if (object instanceof Mesh) {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) {
        for (const mat of object.material) {
          mat.dispose();
        }
      } else if (object.material) {
        object.material.dispose();
      }
    }
  });

  // Dispose renderer
  state.renderer.dispose();
}
