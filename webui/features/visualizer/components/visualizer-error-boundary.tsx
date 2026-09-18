// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Button } from "../../../components/ui/visual-language/button";
/**
 * Error boundary for Visualizer.
 * Catches WebGPU/Three.js initialization failures and displays user-friendly error UI.
 */

import { ErrorBoundary, type ParentComponent } from "solid-js";
import { getLogger } from "../../../lib/logger";

const log = getLogger(import.meta.url);

/**
 * Error fallback UI displayed when visualizer initialization fails.
 */
function ErrorFallback(props: { error: Error; reset: () => void }) {
  // Log detailed error for debugging
  log.errorWithCause(props.error, "Initialization error");

  // Check for common WebGPU errors
  const isWebGPUError =
    props.error.message.includes("WebGPU") ||
    props.error.message.includes("GPU") ||
    props.error.message.includes("adapter");

  return (
    <div class="h-full w-full flex items-center justify-center bg-neutral-900">
      <div class="max-w-md rounded-lg bg-neutral-800 p-6 shadow-lg border border-neutral-700">
        <h2 class="mb-2 text-lg font-bold text-red-400">
          Visualizer Failed to Load
        </h2>

        <p class="mb-4 text-neutral-300 text-sm">
          {isWebGPUError
            ? "Your browser may not support WebGPU, which is required for the 3D visualizer."
            : "An error occurred while initializing the visualizer."}
        </p>

        {isWebGPUError && (
          <p class="mb-4 text-neutral-400 text-xs">
            WebGPU is supported in Chrome 113+, Edge 113+, and Firefox 115+
            (with flags). Safari support is experimental.
          </p>
        )}

        <div class="mb-4 p-3 bg-neutral-900 rounded text-xs text-neutral-400 font-mono overflow-auto max-h-24">
          {props.error.message}
        </div>

        <div class="flex gap-2">
          <Button
            size="compact"
            variant="primary"
            type="button"
            onClick={props.reset}
          >
            Retry
          </Button>
          <a
            href="https://caniuse.com/webgpu"
            target="_blank"
            rel="noopener noreferrer"
            class="px-4 py-2 text-sm font-medium text-neutral-300 bg-neutral-700 rounded hover:bg-neutral-600"
          >
            Check Browser Support
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * Error boundary wrapper for Visualizer components.
 * Catches errors during WebGPU/Three.js initialization and displays friendly UI.
 */
export const VisualizerErrorBoundary: ParentComponent = (props) => {
  return (
    <ErrorBoundary
      fallback={(error: Error, reset) => (
        <ErrorFallback error={error} reset={reset} />
      )}
    >
      {props.children}
    </ErrorBoundary>
  );
};
