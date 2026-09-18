// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Object Library Properties Panel
 *
 * Displays detailed information about the selected object from the library,
 * including a 3D preview of the model.
 */

import { useStore } from "@nanostores/solid";
import {
  type Component,
  createEffect,
  createMemo,
  onCleanup,
  Show,
} from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getBackendUrl } from "../../../lib/api";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { objectProfile } from "../../../state/appStores";
import type { AvailableObjectInfo } from "../../../types";

const log = getLogger(import.meta.url);

interface ObjectLibraryPropertiesProps {
  selectedObject: AvailableObjectInfo | null;
}

const loader = new GLTFLoader();

const ObjectLibraryProperties: Component<ObjectLibraryPropertiesProps> = (
  props,
) => {
  let containerRef: HTMLDivElement | undefined;
  let rendererRef: THREE.WebGLRenderer | undefined;
  let sceneRef: THREE.Scene | undefined;
  let cameraRef: THREE.PerspectiveCamera | undefined;
  let controlsRef: OrbitControls | undefined;
  let frameId: number | undefined;
  let currentModel: THREE.Object3D | undefined;
  let previewLoadToken = 0;

  const $objectProfile = useStore(objectProfile);
  const profileMetadata = createMemo(() => {
    const selected = props.selectedObject;
    const profile = $objectProfile();
    if (!selected || !profile || profile.info.name !== selected.name) {
      return null;
    }
    return profile.metadata;
  });

  const disposeModelResources = (model: THREE.Object3D) => {
    model.traverse((child) => {
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
  };

  const clearCurrentModel = () => {
    if (!sceneRef || !currentModel) return;
    sceneRef.remove(currentModel);
    disposeModelResources(currentModel);
    currentModel = undefined;
  };

  // Request object profile whenever selection changes.
  createEffect(() => {
    const selected = props.selectedObject;
    if (!selected) {
      return;
    }

    engineRuntime.sendCommand({
      module: "ObjectLibraryCommand",
      command: {
        type: "GetObjectProfile",
        data: { name: selected.name },
      },
    });
  });

  // Initialize Three.js once the preview container is available.
  createEffect(() => {
    const container = containerRef;
    if (!container || rendererRef) return;

    sceneRef = new THREE.Scene();
    sceneRef.background = new THREE.Color(0x1a1a1a);

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
    controlsRef.dampingFactor = 0.05;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    sceneRef.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 5, 5);
    sceneRef.add(directionalLight);

    const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    sceneRef.add(gridHelper);

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

    onCleanup(() => {
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      clearCurrentModel();
      rendererRef?.dispose();
      controlsRef?.dispose();
      rendererRef = undefined;
      controlsRef = undefined;
      sceneRef = undefined;
      cameraRef = undefined;
    });
  });

  // Clear model when selection is cleared.
  createEffect(() => {
    if (!props.selectedObject) {
      previewLoadToken += 1;
      clearCurrentModel();
    }
  });

  // Load model when matching profile arrives.
  createEffect(() => {
    const selected = props.selectedObject;
    const profile = $objectProfile();
    if (!selected || !profile || !sceneRef) return;
    if (profile.info.name !== selected.name) return;

    const modelPath = profile.info.modelPath;
    if (!modelPath) {
      previewLoadToken += 1;
      clearCurrentModel();
      return;
    }

    const loadToken = ++previewLoadToken;
    const requestedObjectName = selected.name;
    clearCurrentModel();
    const modelUrl = `${getBackendUrl()}/api/object-model/${modelPath}`;
    log.debug(`Loading object model from: ${modelUrl}`);

    loader.load(
      modelUrl,
      (gltf) => {
        if (
          loadToken !== previewLoadToken ||
          props.selectedObject?.name !== requestedObjectName ||
          !sceneRef ||
          !cameraRef ||
          !controlsRef
        ) {
          disposeModelResources(gltf.scene);
          return;
        }
        currentModel = gltf.scene;

        const scale = profile.metadata.scale ?? selected.scale ?? 1;
        currentModel.scale.set(scale, scale, scale);

        const box = new THREE.Box3().setFromObject(currentModel);
        const center = box.getCenter(new THREE.Vector3());
        currentModel.position.sub(center);

        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        cameraRef.position.set(maxDim * 2, maxDim * 1.5, maxDim * 2);
        cameraRef.lookAt(0, 0, 0);
        controlsRef.target.set(0, 0, 0);
        controlsRef.update();

        sceneRef.add(currentModel);
        log.debug("Object model loaded successfully");
      },
      undefined,
      (error) => {
        if (loadToken !== previewLoadToken) return;
        log.error("Failed to load object model:", error);
      },
    );
  });

  return (
    <div class="h-full flex flex-col text-white">
      <div
        ref={containerRef}
        class="h-48 min-h-[192px] bg-neutral-900 border-b border-neutral-700"
      />

      <Show
        when={props.selectedObject}
        fallback={
          <div class="p-4 text-gray-500 text-center">
            Select an object to view details
          </div>
        }
      >
        {(object) => (
          <div class="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <h3 class="text-lg font-semibold">{object().name}</h3>
              <p class="text-sm text-gray-400">{object().category}</p>
            </div>

            <Show when={object().description}>
              <div>
                <label class="text-xs text-gray-500 uppercase">
                  Description
                </label>
                <p class="text-sm">{object().description}</p>
              </div>
            </Show>

            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="text-xs text-gray-500 uppercase">Scale</label>
                <p class="text-sm">{object().scale.toFixed(2)}x</p>
              </div>
            </div>

            <Show when={(object().tags ?? []).length > 0}>
              <div>
                <label class="text-xs text-gray-500 uppercase">Tags</label>
                <div class="flex flex-wrap gap-1 mt-1">
                  {(object().tags ?? []).map((tag) => (
                    <span class="text-xs bg-neutral-700 px-2 py-0.5 rounded">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </Show>

            <Show when={profileMetadata()}>
              {(metadata) => (
                <>
                  <Show when={metadata().author}>
                    <div>
                      <label class="text-xs text-gray-500 uppercase">
                        Author
                      </label>
                      <p class="text-sm">{metadata().author}</p>
                    </div>
                  </Show>
                  <Show when={metadata().license}>
                    <div>
                      <label class="text-xs text-gray-500 uppercase">
                        License
                      </label>
                      <p class="text-sm">{metadata().license}</p>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
};

export default ObjectLibraryProperties;
