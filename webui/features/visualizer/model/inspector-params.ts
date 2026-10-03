// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Inspector } from "three/examples/jsm/inspector/Inspector.js";
import type { PerspectiveCamera, WebGPURenderer } from "three/webgpu";
import {
  type PostProcessingState,
  updateBloomConfig,
} from "../rendering/effects/post-processing";
import type { SceneEnvironment } from "../rendering/scene-environment";
import {
  DEFAULT_CAMERA_POSITION,
  DEFAULT_CAMERA_TARGET,
  getCameraState,
  saveCameraState,
} from "./camera-state";

/**
 * Setup inspector parameters for scene controls.
 */
export function setupInspectorParams(
  renderer: WebGPURenderer,
  inspector: Inspector,
  camera: PerspectiveCamera,
  controls: OrbitControls,
  environment: SceneEnvironment,
  postProcessing: PostProcessingState,
): () => void {
  const gui = inspector.createParameters("Scene Settings");

  // Camera folder
  const cameraFolder = gui.addFolder("Camera");
  cameraFolder.add(camera.position, "x", -50, 50).name("Position X");
  cameraFolder.add(camera.position, "y", -50, 50).name("Position Y");
  cameraFolder.add(camera.position, "z", -50, 50).name("Position Z");

  const cameraStats = {
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    distance: 0,
    azimuthDeg: 0,
    elevationDeg: 0,
  };
  const cameraStatControllers = [
    cameraFolder.add(cameraStats, "targetX", -200, 200).name("Target X"),
    cameraFolder.add(cameraStats, "targetY", -200, 200).name("Target Y"),
    cameraFolder.add(cameraStats, "targetZ", -200, 200).name("Target Z"),
    cameraFolder.add(cameraStats, "distance", 0, 500).name("Distance"),
    cameraFolder
      .add(cameraStats, "azimuthDeg", -180, 180)
      .name("Azimuth (deg)"),
    cameraFolder
      .add(cameraStats, "elevationDeg", -90, 90)
      .name("Elevation (deg)"),
  ];
  cameraStatControllers.forEach((controller) => {
    controller.listen();
  });
  cameraStatControllers.forEach((controller) => {
    const domElement = (controller as { domElement?: HTMLElement }).domElement;
    const inputs = domElement?.querySelectorAll("input");
    inputs?.forEach((input) => {
      input.disabled = true;
    });
  });

  cameraFolder
    .add(camera, "fov", 10, 120)
    .name("FOV")
    .onChange(() => camera.updateProjectionMatrix());

  // Reset camera button
  const resetCamera = {
    reset: () => {
      camera.position.set(
        DEFAULT_CAMERA_POSITION.x,
        DEFAULT_CAMERA_POSITION.y,
        DEFAULT_CAMERA_POSITION.z,
      );
      controls.target.set(
        DEFAULT_CAMERA_TARGET.x,
        DEFAULT_CAMERA_TARGET.y,
        DEFAULT_CAMERA_TARGET.z,
      );
      camera.lookAt(controls.target);
      saveCameraState(getCameraState(camera, controls));
    },
  };
  cameraFolder.add(resetCamera, "reset").name("Reset Camera");

  // Renderer folder
  const rendererFolder = gui.addFolder("Renderer");
  rendererFolder.add(renderer, "toneMappingExposure", 0.1, 3).name("Exposure");

  // Lights folder
  const lightsFolder = gui.addFolder("Lights");
  lightsFolder.add(environment.ambientLight, "intensity", 0, 2).name("Ambient");
  lightsFolder
    .add(environment.directionalLight, "intensity", 0, 2)
    .name("Directional");
  lightsFolder.add(environment.fillLight, "intensity", 0, 2).name("Fill");

  // Grid folder
  const gridFolder = gui.addFolder("Grid");
  gridFolder.add(environment.grid, "visible").name("Show Grid");
  gridFolder.add(environment.axesHelper, "visible").name("Show Axes");
  gridFolder.add(environment.floor, "visible").name("Show Floor");

  // Effects folder (bloom/fog)
  const effectsFolder = gui.addFolder("Effects");
  const bloomConfig = { ...postProcessing.config };
  effectsFolder
    .add(bloomConfig, "bloomStrength", 0, 2)
    .name("Bloom Strength")
    .onChange((value: number) => {
      updateBloomConfig(postProcessing, { bloomStrength: value });
    });
  effectsFolder
    .add(bloomConfig, "bloomRadius", 0, 1)
    .name("Bloom Radius")
    .onChange((value: number) => {
      updateBloomConfig(postProcessing, { bloomRadius: value });
    });

  const toDeg = (rad: number) => (rad * 180) / Math.PI;

  const updateCameraStats = () => {
    const distance = camera.position.distanceTo(controls.target);
    const azimuth = controls.getAzimuthalAngle();
    const elevation = Math.PI / 2 - controls.getPolarAngle();

    cameraStats.targetX = Number(controls.target.x.toFixed(2));
    cameraStats.targetY = Number(controls.target.y.toFixed(2));
    cameraStats.targetZ = Number(controls.target.z.toFixed(2));
    cameraStats.distance = Number(distance.toFixed(2));
    cameraStats.azimuthDeg = Number(toDeg(azimuth).toFixed(1));
    cameraStats.elevationDeg = Number(toDeg(elevation).toFixed(1));
  };

  updateCameraStats();
  return updateCameraStats;
}
