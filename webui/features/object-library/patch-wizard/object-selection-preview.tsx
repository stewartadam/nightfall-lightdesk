// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Component,
  createEffect,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getBackendUrl } from "../../../lib/api";
import { getLogger } from "../../../lib/logger";
import { type AvailableObjectInfo, SceneObjectType } from "../../../types";

const log = getLogger(import.meta.url);
const loader = new GLTFLoader();

type PreviewableSelectionSource =
  | { type: "library"; object: Pick<AvailableObjectInfo, "modelPath"> }
  | { type: "default"; objectType: SceneObjectType };

interface PreviewableObjectSelection {
  name: string;
  scale: number;
  source: PreviewableSelectionSource;
}

interface ObjectSelectionPreviewProps {
  selectedObject: PreviewableObjectSelection | null;
}

type PreviewStatus = {
  message: string;
  tone: "info" | "warn";
};

function disposeObjectResources(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        for (const material of child.material) {
          material.dispose();
        }
      } else {
        child.material?.dispose();
      }
    }
  });
}

function fitCameraToObject(
  object: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);

  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);

  camera.position.set(maxDim * 2, maxDim * 1.5, maxDim * 2);
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

function createDefaultPreview(
  objectType: SceneObjectType,
  scale: number,
): THREE.Object3D {
  const safeScale = Math.max(0.1, scale || 1);
  const group = new THREE.Group();

  if (objectType === SceneObjectType.Truss) {
    const railMaterial = new THREE.MeshStandardMaterial({
      color: 0x5a5a5a,
      metalness: 0.75,
      roughness: 0.25,
    });
    const braceMaterial = new THREE.MeshStandardMaterial({
      color: 0x4b4b4b,
      metalness: 0.65,
      roughness: 0.35,
    });
    const length = 2.4 * safeScale;
    const halfDepth = 0.25 * safeScale;
    const halfHeight = 0.2 * safeScale;
    const railRadius = 0.03 * safeScale;
    for (const y of [-halfHeight, halfHeight]) {
      for (const z of [-halfDepth, halfDepth]) {
        const rail = new THREE.Mesh(
          new THREE.CylinderGeometry(railRadius, railRadius, length, 12),
          railMaterial,
        );
        rail.rotation.z = Math.PI / 2;
        rail.position.set(0, y, z);
        group.add(rail);
      }
    }
    for (const x of [-0.8, 0, 0.8].map((value) => value * safeScale)) {
      const brace = new THREE.Mesh(
        new THREE.BoxGeometry(
          0.08 * safeScale,
          0.42 * safeScale,
          0.5 * safeScale,
        ),
        braceMaterial,
      );
      brace.position.set(x, 0, 0);
      group.add(brace);
    }
    return group;
  }

  if (objectType === SceneObjectType.Audience) {
    const audienceMaterial = new THREE.MeshStandardMaterial({
      color: 0x6a6a6a,
      metalness: 0.05,
      roughness: 0.9,
    });
    const spacing = 0.25 * safeScale;
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        const person = new THREE.Mesh(
          new THREE.CylinderGeometry(
            0.05 * safeScale,
            0.09 * safeScale,
            0.32 * safeScale,
            8,
          ),
          audienceMaterial,
        );
        person.position.set(x * spacing, 0.16 * safeScale, z * spacing);
        group.add(person);
      }
    }
    return group;
  }

  const stageMaterial = new THREE.MeshStandardMaterial({
    color: objectType === SceneObjectType.StageElement ? 0x2e2e2e : 0x8a8a8a,
    metalness: 0.25,
    roughness: 0.6,
  });

  const boxSize =
    objectType === SceneObjectType.StageElement
      ? [1.4, 0.4, 1.2]
      : [0.7, 0.7, 0.7];
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(
      boxSize[0] * safeScale,
      boxSize[1] * safeScale,
      boxSize[2] * safeScale,
    ),
    stageMaterial,
  );
  box.position.y = (boxSize[1] * safeScale) / 2;
  group.add(box);
  return group;
}

const ObjectSelectionPreview: Component<ObjectSelectionPreviewProps> = (
  props,
) => {
  let containerRef: HTMLDivElement | undefined;
  let rendererRef: THREE.WebGLRenderer | undefined;
  let sceneRef: THREE.Scene | undefined;
  let cameraRef: THREE.PerspectiveCamera | undefined;
  let controlsRef: OrbitControls | undefined;
  let frameId: number | undefined;
  let currentObject: THREE.Object3D | undefined;
  let previewLoadToken = 0;

  const [sceneReady, setSceneReady] = createSignal(false);
  const [status, setStatus] = createSignal<PreviewStatus | null>({
    message: "Select an object to preview.",
    tone: "info",
  });

  const clearCurrentObject = () => {
    if (!sceneRef || !currentObject) return;
    sceneRef.remove(currentObject);
    disposeObjectResources(currentObject);
    currentObject = undefined;
  };

  createEffect(() => {
    const container = containerRef;
    if (!container || rendererRef) return;

    sceneRef = new THREE.Scene();
    sceneRef.background = new THREE.Color(0x141414);

    cameraRef = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );
    cameraRef.position.set(3, 2, 3);

    rendererRef = new THREE.WebGLRenderer({ antialias: true });
    rendererRef.setSize(container.clientWidth, container.clientHeight);
    rendererRef.setPixelRatio(window.devicePixelRatio);
    container.appendChild(rendererRef.domElement);

    controlsRef = new OrbitControls(cameraRef, rendererRef.domElement);
    controlsRef.enableDamping = true;
    controlsRef.dampingFactor = 0.06;

    sceneRef.add(new THREE.AmbientLight(0xffffff, 0.5));
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 5, 4);
    sceneRef.add(directionalLight);
    sceneRef.add(new THREE.GridHelper(10, 10, 0x3a3a3a, 0x1f1f1f));

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controlsRef?.update();
      if (rendererRef && sceneRef && cameraRef) {
        rendererRef.render(sceneRef, cameraRef);
      }
    };
    animate();

    const handleResize = () => {
      if (!containerRef || !cameraRef || !rendererRef) return;
      cameraRef.aspect = containerRef.clientWidth / containerRef.clientHeight;
      cameraRef.updateProjectionMatrix();
      rendererRef.setSize(containerRef.clientWidth, containerRef.clientHeight);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);
    setSceneReady(true);

    onCleanup(() => {
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      previewLoadToken += 1;
      clearCurrentObject();
      rendererRef?.dispose();
      controlsRef?.dispose();
      setSceneReady(false);
      rendererRef = undefined;
      controlsRef = undefined;
      sceneRef = undefined;
      cameraRef = undefined;
    });
  });

  createEffect(() => {
    if (!sceneReady() || !sceneRef || !cameraRef || !controlsRef) return;
    const selected = props.selectedObject;
    const loadToken = ++previewLoadToken;
    clearCurrentObject();

    if (!selected) {
      setStatus({ message: "Select an object to preview.", tone: "info" });
      return;
    }

    if (selected.source.type === "default") {
      const previewObject = createDefaultPreview(
        selected.source.objectType,
        selected.scale,
      );
      currentObject = previewObject;
      sceneRef.add(previewObject);
      fitCameraToObject(previewObject, cameraRef, controlsRef);
      setStatus({ message: "Showing built-in shape preview.", tone: "info" });
      return;
    }

    const modelPath = selected.source.object.modelPath;
    if (!modelPath) {
      const previewObject = createDefaultPreview(
        SceneObjectType.Custom,
        selected.scale,
      );
      currentObject = previewObject;
      sceneRef.add(previewObject);
      fitCameraToObject(previewObject, cameraRef, controlsRef);
      setStatus({
        message: "No model path found; showing placeholder.",
        tone: "warn",
      });
      return;
    }

    setStatus({ message: "Loading model preview…", tone: "info" });
    const modelUrl = `${getBackendUrl()}/api/object-model/${modelPath}`;
    loader.load(
      modelUrl,
      (gltf) => {
        if (
          loadToken !== previewLoadToken ||
          !sceneRef ||
          !cameraRef ||
          !controlsRef
        ) {
          disposeObjectResources(gltf.scene);
          return;
        }

        currentObject = gltf.scene;
        currentObject.scale.set(selected.scale, selected.scale, selected.scale);
        sceneRef.add(currentObject);
        fitCameraToObject(currentObject, cameraRef, controlsRef);
        setStatus(null);
      },
      undefined,
      (error) => {
        if (
          loadToken !== previewLoadToken ||
          !sceneRef ||
          !cameraRef ||
          !controlsRef
        ) {
          return;
        }
        log.warn("Failed to load object preview model", error);
        const previewObject = createDefaultPreview(
          SceneObjectType.Custom,
          selected.scale,
        );
        currentObject = previewObject;
        sceneRef.add(previewObject);
        fitCameraToObject(previewObject, cameraRef, controlsRef);
        setStatus({
          message: "Failed to load model preview; showing placeholder.",
          tone: "warn",
        });
      },
    );
  });

  return (
    <div class="rounded border border-neutral-700 bg-neutral-900 overflow-hidden">
      <div ref={containerRef} class="h-56 bg-neutral-950" />
      <Show when={status()}>
        {(current) => (
          <div
            class="px-3 py-2 border-t border-neutral-700 text-xs"
            classList={{
              "text-neutral-400": current().tone === "info",
              "text-amber-300": current().tone === "warn",
            }}
          >
            {current().message}
          </div>
        )}
      </Show>
    </div>
  );
};

export default ObjectSelectionPreview;
