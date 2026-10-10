// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { AppWindowIcon } from "@squidlab/phosphor-solid/app-window";
import { CaretLeftIcon } from "@squidlab/phosphor-solid/caret-left";
import { CaretRightIcon } from "@squidlab/phosphor-solid/caret-right";
import { CodeIcon } from "@squidlab/phosphor-solid/code";
import { FileTextIcon } from "@squidlab/phosphor-solid/file-text";
import { HardDrivesIcon } from "@squidlab/phosphor-solid/hard-drives";
import { ListIcon } from "@squidlab/phosphor-solid/list";
import { WifiHighIcon } from "@squidlab/phosphor-solid/wifi-high";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { TempoControls } from "../../../features/tempo";
import { APP_BUILD_ID, APP_BUILD_NAME } from "../../../lib/app-metadata";
import { connectionStatus } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { isEmbeddedDemoRuntime } from "../../../lib/runtime-config";
import { currentShowfileName } from "../../../lib/showfile-loading";
import { isE2eBuild } from "../../../lib/test-mode";
import {
  frameStats,
  smoothedEngineMetrics,
  wsLatency,
  wsStats,
} from "../../../state/appStores";
import { ToolbarButton } from "../../ui/toolbar-button";
import Tooltip from "../../ui/tooltip";
import BrowserDemoBanner from "../runtime/browser-demo-banner";
import AppMenu from "./app-menu";
import { ConnectionIndicator } from "./connection-indicator";
import { smoothStatusMetric } from "./model";
import UndoControls from "./undo-controls";

const log = getLogger(import.meta.url);
const STATUS_METRIC_DISPLAY_INTERVAL_MS = 1000;
const STATUS_ICON_SLOT_CLASS = "nf-toolbar-slot";
const STATUS_ICON_GROUP_CLASS = "flex items-center gap-1";

/** Renders connection health, optional metrics, and showfile controls. */
export default function StatusBar() {
  const [currentTime, setCurrentTime] = createSignal(
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );
  const [displayedLatencyMs, setDisplayedLatencyMs] = createSignal(0);
  const [displayedDeliveryLagMs, setDisplayedDeliveryLagMs] = createSignal(0);
  const [displayedFps, setDisplayedFps] = createSignal(0);
  const [displayedFrontendFps, setDisplayedFrontendFps] = createSignal(0);
  const [showMetrics, setShowMetrics] = createSignal(false);
  const latency = useStore(wsLatency);
  const websocketStats = useStore(wsStats);
  const backendMetrics = useStore(smoothedEngineMetrics);
  const frontendFrameStats = useStore(frameStats);
  const showfileName = useStore(currentShowfileName);
  const connStatus = connectionStatus;

  // Update intervals
  let timeInterval: number;

  /** Main-thread websocket delivery lag before status-bar display sampling. */
  const currentDeliveryLagMs = () =>
    websocketStats()?.main.avgDeliveryLagMs ?? latency();

  /** Backend frame rate before status-bar display sampling. */
  const currentFps = () => backendMetrics().fps;

  /** Browser frame rate before status-bar display sampling. */
  const currentFrontendFps = () => frontendFrameStats()?.fps ?? 0;

  /** Refreshes status-bar performance values at a stable display cadence. */
  const refreshDisplayedMetrics = () => {
    setDisplayedLatencyMs((current) => smoothStatusMetric(current, latency()));
    setDisplayedDeliveryLagMs((current) =>
      smoothStatusMetric(current, currentDeliveryLagMs()),
    );
    setDisplayedFps((current) => smoothStatusMetric(current, currentFps()));
    setDisplayedFrontendFps((current) =>
      smoothStatusMetric(current, currentFrontendFps()),
    );
  };

  onMount(() => {
    log.trace("mounting");
    refreshDisplayedMetrics();

    // Update time every second
    timeInterval = window.setInterval(() => {
      refreshDisplayedMetrics();
      setCurrentTime(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    }, STATUS_METRIC_DISPLAY_INTERVAL_MS);
  });

  onCleanup(() => {
    log.trace("unmounting");
    clearInterval(timeInterval);
  });

  return (
    <div
      aria-label="Application status bar"
      class="nf-status-bar w-full h-8 shrink-0 px-4 flex items-center justify-between text-xs"
      role="region"
    >
      <div class={STATUS_ICON_GROUP_CLASS}>
        <AppMenu
          triggerLabel="Menu"
          trigger={<ListIcon class="size-4 text-gray-400" aria-hidden />}
        />

        <ConnectionIndicator class={STATUS_ICON_SLOT_CLASS} />
        <Show when={connStatus() === "connected"}>
          <div class="flex items-center gap-2">
            <ToolbarButton
              label={showMetrics() ? "Hide metrics" : "Show metrics"}
              aria-expanded={showMetrics()}
              aria-controls="status-metrics"
              onClick={() => setShowMetrics((visible) => !visible)}
            >
              <Dynamic
                component={showMetrics() ? CaretLeftIcon : CaretRightIcon}
                class="size-4"
                aria-hidden
              />
            </ToolbarButton>
            <div
              id="status-metrics"
              hidden={!showMetrics()}
              class="items-center gap-3 font-mono text-xs"
              classList={{ flex: showMetrics() }}
            >
              <span class="inline-flex items-center gap-1">
                <WifiHighIcon class="size-4 text-gray-500" aria-hidden />
                {`${displayedLatencyMs().toFixed(1)}ms / ${displayedDeliveryLagMs().toFixed(1)}ms`}
              </span>
              <span class="inline-flex items-center gap-1">
                <HardDrivesIcon class="size-4 text-gray-500" aria-hidden />
                {`${displayedFps().toFixed(0)} Hz`}
              </span>
              <span class="inline-flex items-center gap-1">
                <AppWindowIcon class="size-4 text-gray-500" aria-hidden />
                {`${displayedFrontendFps().toFixed(0)} FPS`}
              </span>
              <span
                aria-hidden="true"
                class="h-4 w-px shrink-0 bg-gray-700"
                data-testid="status-metrics-separator"
              />
            </div>
          </div>
        </Show>
      </div>

      <BrowserDemoBanner />

      <div class="flex items-center gap-2">
        <Show when={connStatus() === "connected"}>
          <div class="contents">
            <TempoControls placement="above" />
            <div aria-hidden="true" class="h-4 w-px bg-gray-700" />
          </div>
        </Show>
        <Tooltip content={() => `Showfile: ${showfileName()}`}>
          <div
            data-testid="status-showfile-name"
            class="inline-flex min-w-0 max-w-64 items-center gap-1 px-2 py-0.5 font-mono text-xs text-gray-400"
          >
            <FileTextIcon class="size-3.5 shrink-0 text-gray-500" aria-hidden />
            <span class="min-w-0 truncate">{showfileName()}</span>
          </div>
        </Tooltip>
        <Show
          when={(import.meta.env.DEV || isE2eBuild) && !isEmbeddedDemoRuntime()}
        >
          <Tooltip content={() => `${APP_BUILD_NAME} (${APP_BUILD_ID})`}>
            <div
              data-testid="status-build-name"
              class="inline-flex min-w-0 max-w-80 items-center gap-1 px-2 py-0.5 font-mono text-xs text-gray-400"
            >
              <CodeIcon class="size-3.5 shrink-0 text-gray-500" aria-hidden />
              <span class="min-w-0 truncate">{APP_BUILD_NAME}</span>
            </div>
          </Tooltip>
        </Show>
        <div
          aria-hidden="true"
          class="h-4 w-px bg-gray-700"
          data-testid="status-build-separator"
        />
        <Show when={connStatus() === "connected"}>
          <div class="contents">
            <UndoControls placement="above" />
            <div
              aria-hidden="true"
              class="h-4 w-px bg-gray-700"
              data-testid="status-undo-separator"
            />
          </div>
        </Show>
        <div class="flex items-center" data-testid="status-clock">
          {currentTime()}
        </div>
      </div>
    </div>
  );
}
