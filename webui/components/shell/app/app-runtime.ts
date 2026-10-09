// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getBackendUrl, getWebSocketUrl } from "../../../lib/api";
import { frameMonitor } from "../../../lib/frame-monitor";
import { getLogger } from "../../../lib/logger";
import { longAnimationFrameMonitor } from "../../../lib/long-animation-frame-monitor";
import { metricsHistoryCollector } from "../../../lib/metrics-history";
import { installNanostoreListenerInstrumentationForAll } from "../../../lib/nanostore-listener-performance";
import {
  startNanostoresLogger,
  stopNanostoresLogger,
} from "../../../lib/nanostores-logger";
import { refreshReservedOutputTargetKeywords } from "../../../lib/network-dmx-output-targets";
import { registerAllComponents } from "../../../lib/panel-registration";
import { startPerformanceMeasureCollector } from "../../../lib/performance-measure-collector";
import { initializePrelineRuntime } from "../../../lib/preline-runtime";
import { isEmbeddedDemoRuntime } from "../../../lib/runtime-config";

const log = getLogger(import.meta.url);

/** Installs store-listener attribution for latency investigations. */
function installPerformanceStoreInstrumentation(): void {
  installNanostoreListenerInstrumentationForAll();
}

/** Starts application-wide runtime services and returns their cleanup function. */
export function initializeApplicationRuntime(): () => void {
  log.trace("Application initializing");
  if (isEmbeddedDemoRuntime()) {
    log.info("Using the embedded Nightfall browser demo runtime");
  } else {
    log.info(`Resolved backend URL: ${getBackendUrl()}`);
    log.info(`Resolved websocket URL: ${getWebSocketUrl()}`);
  }
  registerAllComponents();
  if (!isEmbeddedDemoRuntime()) {
    void refreshReservedOutputTargetKeywords().catch((error: unknown) => {
      log.warn("Failed to warm reserved output target keywords", error);
    });
  }
  frameMonitor.start();
  longAnimationFrameMonitor.start();
  metricsHistoryCollector.start();
  startPerformanceMeasureCollector();
  installPerformanceStoreInstrumentation();
  startNanostoresLogger();

  return () => {
    frameMonitor.stop();
    longAnimationFrameMonitor.stop();
    metricsHistoryCollector.stop();
    stopNanostoresLogger();
  };
}

/** Loads and initializes Preline after the shell DOM has been committed. */
export function initializePreline(): void {
  void initializePrelineRuntime().catch((error: unknown) =>
    log.error("Failed to initialize Preline", error),
  );
}
