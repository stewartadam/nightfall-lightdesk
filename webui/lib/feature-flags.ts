// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

const STORAGE_KEY = "nightfall-feature-flags";

export type VisualizerBeamQuality = "high" | "medium" | "low";

interface FeatureFlags {
  visualizerOffscreenCanvas: boolean;
  visualizerBeamQuality: VisualizerBeamQuality;
  startupDraftRecovery: boolean;
}

interface FeatureFlagSettings {
  features?: {
    visualizerOffscreenCanvas?: unknown;
    visualizerBeamQuality?: unknown;
    startupDraftRecovery?: unknown;
  };
}

const DEFAULT_FEATURES: FeatureFlags = {
  visualizerOffscreenCanvas: true,
  visualizerBeamQuality: "high",
  startupDraftRecovery: true,
};

/** Parses the legacy offscreen-canvas flag format from a URL parameter. */
function parseVisualizerOffscreenCanvas(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

/** Parses visualizer beam quality from a URL parameter or stored setting. */
function parseVisualizerBeamQuality(value: unknown): VisualizerBeamQuality {
  return value === "low" || value === "medium"
    ? value
    : DEFAULT_FEATURES.visualizerBeamQuality;
}

let visualizerQualityUrlOverride: VisualizerBeamQuality | undefined;

/** Consumes an explicit diagnostic URL override once, so Settings remains authoritative afterward. */
export function consumeVisualizerQualityUrlOverride():
  | VisualizerBeamQuality
  | undefined {
  const quality = visualizerQualityUrlOverride;
  visualizerQualityUrlOverride = undefined;
  return quality;
}

let startupDraftRecoveryUrlOverride: boolean | undefined;
let visualizerDefaultPanelUrlOverride: boolean | undefined;
let visualizerInspectorUrlOverride = false;

/** Enables the full Three.js developer profiler only for an explicit diagnostic session. */
export function isVisualizerInspectorEnabled(): boolean {
  return visualizerInspectorUrlOverride;
}

/** Parses permissive boolean values from URL feature flag parameters. */
function parseBooleanFeatureFlag(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Reads feature flag state from local storage with default fallbacks. */
function getFeatureFlags(): FeatureFlags {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return { ...DEFAULT_FEATURES };
    }

    const parsed = JSON.parse(stored) as FeatureFlagSettings;
    const visualizerOffscreenCanvas =
      typeof parsed.features?.visualizerOffscreenCanvas === "boolean"
        ? parsed.features.visualizerOffscreenCanvas
        : DEFAULT_FEATURES.visualizerOffscreenCanvas;
    const visualizerBeamQuality = parseVisualizerBeamQuality(
      parsed.features?.visualizerBeamQuality,
    );
    const startupDraftRecovery =
      typeof parsed.features?.startupDraftRecovery === "boolean"
        ? parsed.features.startupDraftRecovery
        : DEFAULT_FEATURES.startupDraftRecovery;
    return {
      visualizerOffscreenCanvas,
      visualizerBeamQuality,
      startupDraftRecovery,
    };
  } catch (error) {
    log.error("Error reading feature flags:", error);
    return { ...DEFAULT_FEATURES };
  }
}

/** Merges and stores feature flag updates in local storage. */
function saveFeatureFlags(features: Partial<FeatureFlags>): void {
  try {
    const updated = { ...getFeatureFlags(), ...features };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ features: updated }));
    log.debug("Feature flags saved:", updated);
  } catch (error) {
    log.error("Error saving feature flags:", error);
  }
}

/** Returns whether the visualizer should render via an offscreen canvas. */
export function isOffscreenCanvasEnabled(): boolean {
  return getFeatureFlags().visualizerOffscreenCanvas;
}

/** Returns the visualizer beam render quality selected at startup. */
export function getVisualizerBeamQuality(): VisualizerBeamQuality {
  return getFeatureFlags().visualizerBeamQuality;
}

/** Returns whether a fresh default layout should include the 3D visualizer. */
export function isVisualizerDefaultPanelEnabled(): boolean {
  return visualizerDefaultPanelUrlOverride ?? true;
}

/** Returns whether startup should gate on draft recovery checks. */
export function isStartupDraftRecoveryEnabled(): boolean {
  if (startupDraftRecoveryUrlOverride !== undefined) {
    return startupDraftRecoveryUrlOverride;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get("e2e") === "1") {
    return false;
  }

  return getFeatureFlags().startupDraftRecovery;
}

/** Applies recognized feature flag URL parameters to stored settings. */
function parseFeatureFlagUrlParams(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    let changed = false;

    const inspector = params.get("visualizer:inspector");
    if (inspector !== null) {
      visualizerInspectorUrlOverride = parseBooleanFeatureFlag(inspector);
      changed = true;
    }

    const offscreenCanvas = params.get("visualizer:offscreenCanvas");
    if (offscreenCanvas !== null) {
      const value = parseVisualizerOffscreenCanvas(offscreenCanvas);
      saveFeatureFlags({ visualizerOffscreenCanvas: value });
      log.debug(`URL param set visualizerOffscreenCanvas=${value}`);
      changed = true;
    }

    const beamQuality = params.get("visualizer:beamQuality");
    if (beamQuality !== null) {
      const value = parseVisualizerBeamQuality(beamQuality);
      visualizerQualityUrlOverride = value;
      saveFeatureFlags({ visualizerBeamQuality: value });
      log.debug(`URL param set visualizerBeamQuality=${value}`);
      changed = true;
    }

    const visualizerDefaultPanel = params.get("visualizer:defaultPanel");
    if (visualizerDefaultPanel !== null) {
      visualizerDefaultPanelUrlOverride = parseBooleanFeatureFlag(
        visualizerDefaultPanel,
      );
      log.debug(
        `URL param set visualizerDefaultPanel=${visualizerDefaultPanelUrlOverride}`,
      );
      changed = true;
    }

    const startupDraftRecovery = params.get("startup:draftRecovery");
    if (startupDraftRecovery !== null) {
      const value = parseBooleanFeatureFlag(startupDraftRecovery);
      startupDraftRecoveryUrlOverride = value;
      saveFeatureFlags({ startupDraftRecovery: value });
      log.debug(`URL param set startupDraftRecovery=${value}`);
      changed = true;
    }

    return changed;
  } catch (error) {
    log.error("Error parsing feature flag URL params:", error);
    return false;
  }
}

/**
 * Clean feature flag URL params.
 */
function cleanFeatureFlagUrlParams(): void {
  try {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    params.delete("visualizer:offscreenCanvas");
    params.delete("visualizer:beamQuality");
    params.delete("visualizer:defaultPanel");
    params.delete("visualizer:inspector");
    params.delete("startup:draftRecovery");

    const nextUrl =
      url.pathname +
      (params.toString() ? `?${params.toString()}` : "") +
      url.hash;
    window.history.replaceState({}, "", nextUrl);
  } catch (error) {
    log.error("Error cleaning feature flag URL params:", error);
  }
}

/** Initializes feature flags and cleans one-shot URL overrides from the address bar. */
export function initFeatureFlags(): void {
  const changed = parseFeatureFlagUrlParams();
  if (changed) {
    cleanFeatureFlagUrlParams();
  }

  log.debug("Initialized feature flags:", getFeatureFlags());
}
