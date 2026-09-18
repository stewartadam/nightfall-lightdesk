// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Fixture Preview Component for Visualizer.
 * Displays a 3D fixture preview in isolation using the visualizer renderer.
 *
 * This component is designed to be used in the fixture library properties panel
 * for previewing fixtures before adding them to the project.
 */

import { type Component, createEffect, on, onCleanup, onMount } from "solid-js";
import { getLogger } from "../../../lib/logger";

const log = getLogger(import.meta.url);

import {
  disposePreviewRenderer,
  handlePreviewResize,
  initPreviewRenderer,
  type PreviewFixtureDefinition,
  type PreviewRendererState,
  setPreviewFixture,
  startPreviewRenderLoop,
} from "../rendering/preview-renderer";
import { VisualizerErrorBoundary } from "./visualizer-error-boundary";

export interface FixturePreviewProps {
  /** CSS class name for the container */
  class?: string;
  /** Fixture definition to preview */
  fixture: PreviewFixtureDefinition | null;
  /** Optional label to display */
  label?: string;
}

/**
 * Internal preview canvas component (wrapped by error boundary).
 */
const FixturePreviewCanvas: Component<FixturePreviewProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let rendererState: PreviewRendererState | undefined;
  let resizeObserver: ResizeObserver | undefined;

  onMount(() => {
    log.trace("mounting");
    if (!canvasRef || !containerRef) return;

    // Initialize preview renderer
    rendererState = initPreviewRenderer(canvasRef);

    // Set initial fixture if provided
    if (props.fixture) {
      setPreviewFixture(rendererState, props.fixture);
    }

    // Initial size
    const rect = containerRef.getBoundingClientRect();
    handlePreviewResize(rendererState, rect.width, rect.height);

    // Resize observer
    resizeObserver = new ResizeObserver((entries) => {
      if (!rendererState) return;
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          handlePreviewResize(rendererState, width, height);
        }
      }
    });
    resizeObserver.observe(containerRef);

    // Start render loop
    startPreviewRenderLoop(rendererState);

    log.debug("Preview initialized");
  });

  // Update fixture when preview data changes.
  createEffect(
    on(
      () => props.fixture,
      (fixture) => {
        if (rendererState) {
          setPreviewFixture(rendererState, fixture);
        }
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    log.trace("unmounting");
    resizeObserver?.disconnect();
    if (rendererState) {
      disposePreviewRenderer(rendererState);
    }
    log.debug("Preview disposed");
  });

  return (
    <div
      ref={containerRef}
      class={props.class}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
      {props.label && (
        <div class="absolute top-2 left-2 text-sm text-neutral-400 pointer-events-none">
          {props.label}
        </div>
      )}
    </div>
  );
};

/**
 * Fixture Preview Component.
 * Wraps the canvas in an error boundary for WebGPU/Three.js failures.
 */
export const FixturePreview: Component<FixturePreviewProps> = (props) => {
  return (
    <VisualizerErrorBoundary>
      <FixturePreviewCanvas {...props} />
    </VisualizerErrorBoundary>
  );
};
