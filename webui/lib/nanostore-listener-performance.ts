// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { collectNanostoreEntries } from "./nanostore-registry";
import { getCurrentPanelPerformanceContext } from "./panel-performance-context";
import { recordExternalPerformanceMeasure } from "./performance-measure-collector";

type NanostoreListener = (...args: any[]) => void;
type InstrumentableStore = {
  listen: (listener: NanostoreListener) => () => void;
  notify: (...args: any[]) => void;
};

const METRIC_FRAGMENT_PATTERN = /[^a-zA-Z0-9._:/-]+/g;
const instrumentationInstalled = new WeakSet<InstrumentableStore>();
const DEFAULT_EXCLUDED_STORE_NAMES = new Set([
  "engineMetrics",
  "frameStats",
  "longAnimationFrameStats",
  "metricsHistory",
  "performanceMeasureStats",
  "smoothedEngineMetrics",
  "visualizerStats",
  "wsLatency",
  "wsStats",
]);

interface InstallAllNanostoreListenerInstrumentationOptions {
  excludeStoreNames?: ReadonlySet<string>;
}

/** Sanitizes one metric fragment without erasing useful source-path separators. */
function metricFragment(value: string): string {
  return value.trim().replace(METRIC_FRAGMENT_PATTERN, "-");
}

/** Returns whether a stack frame belongs to library code that registers listeners. */
function isInfrastructureFrame(frame: string): boolean {
  return (
    frame.includes("nanostore-listener-performance") ||
    frame.includes("use-shallow-store") ||
    frame.includes("@nanostores/solid") ||
    frame.includes("/nanostores/") ||
    frame.includes("/solid-js/") ||
    frame.includes("/node_modules/")
  );
}

/** Extracts a useful function name from one browser stack frame. */
function functionNameFromStackFrame(frame: string): string | null {
  const match = frame.match(/^\s*at\s+([^\s(]+)/);
  if (!match || match[1].startsWith("http")) return null;
  return match[1];
}

/** Extracts a stable source path and line from one browser stack frame. */
function sourceLabelFromStackFrame(frame: string): string | null {
  const match = frame.match(
    /(?:https?:\/\/[^/]+)?\/([^():]+?\.[cm]?[jt]sx?)(?:\?[^:)]*)?:(\d+):\d+/,
  );
  if (!match) return null;

  const functionName = functionNameFromStackFrame(frame);
  const sourceLocation = `${match[1]}:${match[2]}`;
  return functionName ? `${functionName}@${sourceLocation}` : sourceLocation;
}

/** Labels a listener by the first application frame outside the store bridge. */
function listenerRegistrationLabel(scope: string): string {
  const stack = new Error().stack;
  const panelLabel = panelPerformanceLabel();
  if (!stack) return `${scope}.${panelLabel}.listener.unknown`;

  for (const frame of stack.split("\n").slice(1)) {
    if (isInfrastructureFrame(frame)) continue;
    const sourceLocation = sourceLabelFromStackFrame(frame);
    if (sourceLocation) {
      return `${scope}.${panelLabel}.listener.${metricFragment(sourceLocation)}`;
    }
  }

  return `${scope}.${panelLabel}.listener.unknown`;
}

/** Returns the panel attribution segment for listeners registered inside panels. */
function panelPerformanceLabel(): string {
  const panelContext = getCurrentPanelPerformanceContext();
  if (!panelContext) return "panel.global";

  const componentSegment = panelContext.componentName
    ? `${metricFragment(panelContext.componentName)}.`
    : "";
  return `panel.${componentSegment}${metricFragment(panelContext.panelId)}`;
}

/** Records one timing sample when the duration is a finite non-negative value. */
function recordTiming(name: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  recordExternalPerformanceMeasure(`nightfall:${name}`, durationMs);
}

/** Records one numeric gauge sample in the instrumentation panel. */
function recordGauge(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  recordExternalPerformanceMeasure(`nightfall:${name}`, value, "count");
}

/** Returns whether a discovered Nano Store exposes the internals we wrap. */
function isInstrumentableStore(value: unknown): value is InstrumentableStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "listen" in value &&
    "notify" in value &&
    typeof value.listen === "function" &&
    typeof value.notify === "function"
  );
}

/**
 * Wraps a Nanostore's listener registration so notify fan-out costs are
 * attributed by subscriber registration site in the instrumentation panel.
 */
export function installNanostoreListenerInstrumentation(
  store: InstrumentableStore,
  scope: string,
): void {
  if (instrumentationInstalled.has(store)) return;
  instrumentationInstalled.add(store);

  const originalListen = store.listen.bind(store);
  const originalNotify = store.notify.bind(store);
  const activeListeners = new Set<NanostoreListener>();

  store.notify = (...args: any[]) => {
    recordGauge(`${scope}.listener-count`, activeListeners.size);
    const notificationStartedAtMs = performance.now();
    try {
      originalNotify(...args);
    } finally {
      recordTiming(
        `${scope}.listener-fanout`,
        performance.now() - notificationStartedAtMs,
      );
    }
  };

  store.listen = (listener: NanostoreListener) => {
    const listenerLabel = listenerRegistrationLabel(scope);

    const measuredListener: NanostoreListener = (...args) => {
      const listenerStartedAtMs = performance.now();
      try {
        listener(...args);
      } finally {
        const listenerDurationMs = performance.now() - listenerStartedAtMs;
        recordTiming(listenerLabel, listenerDurationMs);
      }
    };

    activeListeners.add(measuredListener);
    const unsubscribe = originalListen(measuredListener);

    return () => {
      activeListeners.delete(measuredListener);
      unsubscribe();
    };
  };
}

/**
 * Installs listener attribution for all registered application Nano Stores.
 */
export function installNanostoreListenerInstrumentationForAll(
  options: InstallAllNanostoreListenerInstrumentationOptions = {},
): void {
  const excludeStoreNames =
    options.excludeStoreNames ?? DEFAULT_EXCLUDED_STORE_NAMES;

  for (const entry of collectNanostoreEntries()) {
    if (excludeStoreNames.has(entry.name)) continue;
    if (!isInstrumentableStore(entry.store)) continue;

    installNanostoreListenerInstrumentation(entry.store, entry.metricScope);
  }
}
