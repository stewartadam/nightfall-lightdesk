// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Visualizer panel component for dockview integration.
 * Renders GDTF fixtures in a clean, modular 3D scene.
 *
 * Implements occlusion detection to pause rendering when:
 * - Browser tab is not active (Page Visibility API)
 * - Panel is hidden behind another tab in dockview
 * - Panel is scrolled out of view (IntersectionObserver)
 */

import { useStore } from "@nanostores/solid";
import {
  type Component,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  consumeVisualizerQualityUrlOverride,
  isOffscreenCanvasEnabled,
} from "../../../lib/feature-flags";
import { getLogger } from "../../../lib/logger";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { usePanelVisibility } from "../../../lib/use-panel-visibility";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { usePropertiesInspector } from "../../property-inspector";
import { visualizerQualityPreset } from "../state/settings";

const log = getLogger(import.meta.url);

import { VisualizerCanvas } from "../components/visualizer-canvas";
import { VisualizerErrorBoundary } from "../components/visualizer-error-boundary";
import VisualizerProperties from "../components/visualizer-properties";
import { VisualizerToolToolbar } from "../components/visualizer-tool-toolbar";
import {
  createVisualizerContextValue,
  VisualizerContextProvider,
} from "../context/visualizer-context";
import type { VisualizerCanvasApi } from "../controllers/visualizer-canvas-api";
import {
  registerVisualizerDebugApi,
  setActiveVisualizerDebugApiPanel,
  unregisterVisualizerDebugApi,
} from "../services/visualizer-debug-api-registry";

interface VisualizerPanelProps extends BasePanelComponentProps {
  initialPanelId?: string;
}

const VisualizerPanel: Component<VisualizerPanelProps> = (props) => {
  const override = consumeVisualizerQualityUrlOverride();
  if (override) visualizerQualityPreset.set(override);
  const quality = useStore(visualizerQualityPreset);
  log.trace("mounting");
  let visualizerApi: VisualizerCanvasApi | null = null;
  const [visualizerHandle, setVisualizerHandle] =
    createSignal<VisualizerCanvasApi>();
  let containerRef: HTMLDivElement | undefined;
  const panelId = props.initialPanelId ?? props.id;
  const visualizerContext = createVisualizerContextValue({ panelId });

  const workspaceActive = useWorkspaceActivity();

  // Track visibility from multiple sources
  const [isDocumentVisible, setIsDocumentVisible] = createSignal(
    typeof document !== "undefined" && document.visibilityState === "visible",
  );
  const isDockviewVisible = usePanelVisibility(props.panelApi);
  const [isInViewport, setIsInViewport] = createSignal(true);

  /** Combined visibility check - pause if ANY source indicates not visible */
  const shouldRender = () =>
    isDocumentVisible() && isDockviewVisible() && isInViewport();

  /** Applies the current combined visibility state to the visualizer renderer. */
  const syncVisualizerVisibility = () => {
    const visible = shouldRender();
    if (visible) {
      visualizerApi?.resume();
    } else {
      visualizerApi?.pause();
    }
    log.debug(
      `Visibility: doc=${isDocumentVisible()}, dock=${isDockviewVisible()}, viewport=${isInViewport()} -> ${visible ? "rendering" : "paused"}`,
    );
  };

  onCleanup(() => {
    log.trace("unmounting");
  });

  /** Updates rendering state whenever a visibility input changes. */
  createEffect(syncVisualizerVisibility);

  // Page Visibility API - detect tab switches
  onMount(() => {
    const handleVisibilityChange = () => {
      setIsDocumentVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    });
  });

  // IntersectionObserver - detect if panel is scrolled out of view
  onMount(() => {
    if (!containerRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setIsInViewport(entry.isIntersecting);
        }
      },
      { threshold: 0.01 }, // Trigger when at least 1% visible
    );

    observer.observe(containerRef);
    onCleanup(() => observer.disconnect());
  });

  /** Publishes diagnostics only for the active workspace's instance of this panel. */
  createEffect(() => {
    if (!workspaceActive()) return;
    const api = visualizerHandle();
    if (!api) return;
    registerVisualizerDebugApi(panelId, api);
    if (isDockviewVisible()) setActiveVisualizerDebugApiPanel(panelId);
    onCleanup(() => unregisterVisualizerDebugApi(panelId));
  });

  usePropertiesInspector(
    panelId,
    "3D Visualizer",
    () => <VisualizerProperties />,
    { priority: 10, autoActivate: true },
  );

  return (
    <VisualizerContextProvider value={visualizerContext}>
      <div
        ref={containerRef}
        class="flex h-full w-full flex-col overflow-hidden bg-neutral-900"
      >
        <VisualizerToolToolbar />
        <VisualizerErrorBoundary>
          <div class="min-h-0 flex-1">
            <Show when={quality()} keyed>
              {(_preset) => (
                <VisualizerCanvas
                  class="h-full w-full"
                  forceMainThread={!isOffscreenCanvasEnabled()}
                  apiRef={(api) => {
                    visualizerApi = api;
                    setVisualizerHandle(api);
                    syncVisualizerVisibility();
                    if (isDockviewVisible()) {
                      setActiveVisualizerDebugApiPanel(panelId);
                    }
                  }}
                />
              )}
            </Show>
          </div>
        </VisualizerErrorBoundary>
      </div>
    </VisualizerContextProvider>
  );
};

export default VisualizerPanel;
