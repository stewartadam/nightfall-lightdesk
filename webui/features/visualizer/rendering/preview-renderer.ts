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
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  DirectionalLight,
  MathUtils,
  Mesh,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import { getLogger } from "../../../lib/logger";
import type {
  FixtureGeometry,
  GetFixtureProfileResponse,
} from "../../../types";
import type { RenderableFixture } from "../model/types";
import { BeamManager, BeamUpdater } from "./effects";
import type { ExtendedFixtureInstance } from "./fixture-renderers";
import {
  buildFixtureWithoutGeometry,
  buildFixtureWithRenderer,
  disposeFixtureWithRenderer,
  updateFixtureColors,
} from "./fixture-renderers";
import {
  type EmitterColor,
  meshSwapGeneration,
  updateEmitterColors,
} from "./geometry-builder";
import { resolveQualityProfile } from "./quality-profile";

const log = getLogger(import.meta.url);

/**
 * The preview renders straight to the canvas with no bloom pass, so it uses the Medium
 * preset: luminous faces at the unbloomed exposure and shaded cone beams drawn in the
 * preview scene itself, which need no atmospheric pass.
 */
export const PREVIEW_QUALITY = resolveQualityProfile("medium");

/** Fixture UID of the single previewed fixture, used to key its beam apertures. */
const PREVIEW_FIXTURE_UID = "preview";

/** Room left around the fixture's bounding sphere, as a multiple of its radius. */
const FRAMING_MARGIN = 1.15;

/** Default camera angles */
const DEFAULT_AZIMUTH = -Math.PI / 4; // 45 degrees from front-right
const DEFAULT_ELEVATION = -Math.PI / 6; // 30 degrees below horizon (looking upward)
const PREVIEW_EMITTER_COLOR: EmitterColor = {
  red: 1,
  green: 0,
  blue: 0,
  intensity: 1,
};

/**
 * Lights every emitter of the previewed fixture with the preview color and returns the
 * per-element colors so beams can be published from the same values.
 */
function colorPreviewEmitters(
  instance: ExtendedFixtureInstance,
): Map<string, EmitterColor> {
  const elementColors = new Map<string, EmitterColor>();
  if (instance.emitters.size === 0) return elementColors;

  for (const [, emitter] of instance.emitters) {
    elementColors.set(emitter.controlledElement, PREVIEW_EMITTER_COLOR);
  }
  if (instance.rendererType === "gdtf") {
    updateEmitterColors(instance, elementColors);
  } else {
    updateFixtureColors(instance, elementColors);
  }
  return elementColors;
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
 * Builds what the preview draws from a fixture profile (a library fixture's or a fixture-editor
 * draft's), or null while the profile has no converted fixture.
 */
export function profileToPreviewFixture(
  profile: Pick<GetFixtureProfileResponse, "fixture" | "geometry"> | null,
): PreviewFixtureDefinition | null {
  const fixture = profile?.fixture;
  if (!fixture) return null;
  return {
    make: fixture.make,
    model: fixture.model,
    geometry: profile.geometry ?? null,
    elements: fixture.elements,
    beamType: fixture.physical?.beamType,
    layout: fixture.layout,
  };
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
  /** Publishes the previewed fixture's apertures through the visualizer's shared beam batch. */
  beamUpdater: BeamUpdater;
  fixtureInstance: ExtendedFixtureInstance | null;
  isPaused: boolean;
  /** Frames still to draw at full rate after the scene, size or view last changed. */
  activeFrames: number;
  /**
   * When the frame still being drawn started, or null when none is. The loop starts no other
   * frame until it finishes, or until it has taken so long that it is presumed lost.
   */
  renderStartedMs: number | null;
  /** Mesh loads already drawn, to redraw when an archive mesh replaces a placeholder. */
  drawnMeshSwaps: number;
  /** Whether the camera is framed on a fixture with a real size, which a kept view needs. */
  framed: boolean;
  /**
   * Whether the camera still holds the automatic framing. A resize or a mesh that finishes
   * loading frames the fixture again until the user orbits or zooms.
   */
  autoFramed: boolean;
}

/** A frame running longer than this is presumed lost (such as on a lost GPU device), so drawing resumes. */
const LOST_FRAME_MS = 5000;

/** Frames drawn after a change. `renderAsync` waits for shaders to compile, so one is enough. */
const ACTIVE_FRAMES_AFTER_CHANGE = 1;

/** Asks the preview to draw at full rate for a while, after anything on screen changed. */
function markPreviewChanged(state: PreviewRendererState): void {
  state.activeFrames = ACTIVE_FRAMES_AFTER_CHANGE;
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
  // Match the main visualizer's output transform so lit faces and beams roll off the same way.
  renderer.toneMapping = ACESFilmicToneMapping;

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

  const beamUpdater = new BeamUpdater(new BeamManager(scene, PREVIEW_QUALITY));

  const state: PreviewRendererState = {
    renderer,
    scene,
    camera,
    controls,
    ambientLight,
    directionalLight,
    beamUpdater,
    fixtureInstance: null,
    isPaused: false,
    activeFrames: ACTIVE_FRAMES_AFTER_CHANGE,
    renderStartedMs: null,
    drawnMeshSwaps: meshSwapGeneration(),
    framed: false,
    autoFramed: true,
  };
  controls.addEventListener("change", () => markPreviewChanged(state));
  controls.addEventListener("start", () => {
    state.autoFramed = false;
  });
  return state;
}

/**
 * Set the fixture to display in the preview.
 * Disposes any existing fixture and loads the new one, then frames the camera on it. With
 * `keepCamera`, a fixture that replaces another one keeps the current view instead, so a
 * fixture being edited does not jump back to the default angle after each change.
 */
export function setPreviewFixture(
  state: PreviewRendererState,
  fixture: PreviewFixtureDefinition | null,
  options: { keepCamera?: boolean } = {},
): void {
  const replacing = state.fixtureInstance !== null;
  // Dispose existing fixture
  if (state.fixtureInstance) {
    state.scene.remove(state.fixtureInstance.group);
    disposeFixtureWithRenderer(state.fixtureInstance);
    state.fixtureInstance = null;
    state.beamUpdater.syncWithFixtures(new Map());
  }

  // Load new fixture if provided
  if (fixture) {
    const instance = fixture.geometry
      ? buildFixtureWithRenderer(
          "preview",
          fixture.geometry,
          fixture.elements,
          fixture.beamType,
          PREVIEW_QUALITY,
          fixture.layout,
        )
      : buildFixtureWithoutGeometry(
          "preview",
          fixture.elements,
          fixture.beamType,
          PREVIEW_QUALITY,
          fixture.layout,
        );

    if (!instance) {
      // The old fixture is gone either way, so draw the empty scene now.
      state.framed = false;
      markPreviewChanged(state);
      return;
    }

    state.fixtureInstance = instance;
    const elementColors = colorPreviewEmitters(instance);
    state.scene.add(instance.group);
    // Apertures are posed from the fixture's world matrices, so publish once it is in the scene.
    state.beamUpdater.syncWithFixtures(
      new Map([[PREVIEW_FIXTURE_UID, instance]]),
    );
    state.beamUpdater.updateFixtureBeam(
      PREVIEW_FIXTURE_UID,
      instance,
      elementColors,
    );

    // Frame the camera on the new fixture
    if (!(options.keepCamera && replacing && state.framed)) {
      state.autoFramed = true;
      frameCameraOnFixture(state);
    }
  }
  markPreviewChanged(state);
}

/**
 * Points the camera at the fixture from the default angle, as close as it can sit while the
 * fixture's bounding sphere fits both the canvas's height and its width. A tall, narrow canvas
 * has a narrow horizontal field of view, so fitting the height alone would cut the fixture off
 * at the sides.
 */
function frameCameraOnFixture(state: PreviewRendererState): void {
  if (!state.fixtureInstance) return;

  const box = new Box3().setFromObject(state.fixtureInstance.group);
  const sphere = box.getBoundingSphere(new Sphere());
  // A fixture with no size (an empty draft) gives no view worth keeping, so leave the camera.
  state.framed = Number.isFinite(sphere.radius) && sphere.radius > 0;
  if (!state.framed) return;

  const { camera } = state;
  const verticalFov = MathUtils.degToRad(camera.fov);
  const horizontalFov =
    2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(camera.aspect, 1e-3));
  const narrowestFov = Math.min(verticalFov, horizontalFov);
  const distance =
    (sphere.radius * FRAMING_MARGIN) / Math.sin(narrowestFov / 2);

  const direction = new Vector3(
    Math.cos(DEFAULT_ELEVATION) * Math.sin(DEFAULT_AZIMUTH),
    Math.sin(DEFAULT_ELEVATION),
    Math.cos(DEFAULT_ELEVATION) * Math.cos(DEFAULT_AZIMUTH),
  );
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  state.controls.maxDistance = Math.max(20, distance * 2);
  state.controls.target.copy(sphere.center);
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
  if (state.autoFramed) frameCameraOnFixture(state);
  markPreviewChanged(state);
}

/**
 * Start the preview render loop. It draws at full rate while the fixture, the size or the view
 * is changing (including the orbit controls' damping, and a mesh that finishes loading) and for a
 * couple of frames after, and draws nothing while the preview sits still. Drawing an unchanged
 * scene is not free: on a software GPU one frame can hold the page for over a second. A frame that takes longer than the
 * display's refresh (a slow or software GPU) holds back the next one instead of piling up
 * draws until the page stops responding.
 */
export function startPreviewRenderLoop(state: PreviewRendererState): void {
  state.isPaused = false;

  state.renderer.setAnimationLoop((time: number) => {
    if (state.isPaused) return;
    const started = state.renderStartedMs;
    if (started !== null && time - started < LOST_FRAME_MS) return;

    // Skip rendering when the canvas has no area (e.g. tab not visible)
    const { width, height } = state.renderer.getSize(new Vector2());
    if (width <= 0 || height <= 0) return;

    const swaps = meshSwapGeneration();
    if (swaps !== state.drawnMeshSwaps) {
      state.drawnMeshSwaps = swaps;
      if (state.autoFramed) frameCameraOnFixture(state);
      markPreviewChanged(state);
    }
    const moving = state.controls.update();
    if (!moving && state.activeFrames === 0) return;
    if (state.activeFrames > 0) state.activeFrames--;
    state.renderStartedMs = time;
    void state.renderer
      .renderAsync(state.scene, state.camera)
      .catch((error: unknown) => {
        log.warn("Preview frame failed", { error });
      })
      .finally(() => {
        if (state.renderStartedMs === time) state.renderStartedMs = null;
      });
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
  // Removes the shared beam draw before the scene traversal below disposes what remains.
  state.beamUpdater.dispose();

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
