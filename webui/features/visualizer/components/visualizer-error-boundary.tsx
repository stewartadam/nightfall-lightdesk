// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Error boundary for Visualizer.
 * Catches WebGPU/Three.js initialization failures and displays user-friendly error UI.
 */

import { ErrorBoundary, type ParentComponent } from "solid-js";
import { ErrorFallback } from "../../../components/ui/error-fallback";
import { getLogger } from "../../../lib/logger";

const log = getLogger(import.meta.url);

/**
 * Error fallback UI displayed when visualizer initialization fails. Errors
 * that mention the GPU or its adapter add WebGPU support guidance with a link
 * to the browser support table.
 */
function VisualizerErrorFallback(props: { error: unknown; reset: () => void }) {
  log.errorWithCause(props.error, "Initialization error");

  const message =
    props.error instanceof Error ? props.error.message : String(props.error);
  const isWebGPUError =
    message.includes("WebGPU") ||
    message.includes("GPU") ||
    message.includes("adapter");

  return (
    <ErrorFallback
      title="Visualizer failed to load"
      error={props.error}
      reset={props.reset}
      description={
        isWebGPUError ? (
          <>
            <p>
              Your browser may not support WebGPU, which is required for the 3D
              visualizer.
            </p>
            <p class="text-xs text-neutral-400">
              WebGPU is supported in Chrome 113+, Edge 113+, and Firefox 115+
              (with flags). Safari support is experimental.{" "}
              <a
                href="https://caniuse.com/webgpu"
                target="_blank"
                rel="noopener noreferrer"
              >
                Check browser support
              </a>
            </p>
          </>
        ) : (
          "An error occurred while initializing the visualizer."
        )
      }
    />
  );
}

/**
 * Error boundary wrapper for Visualizer components.
 * Catches errors during WebGPU/Three.js initialization and displays friendly UI.
 */
export const VisualizerErrorBoundary: ParentComponent = (props) => {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <VisualizerErrorFallback error={error} reset={reset} />
      )}
    >
      {props.children}
    </ErrorBoundary>
  );
};
