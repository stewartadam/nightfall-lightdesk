// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { persistentAtom } from "@nanostores/persistent";
import type { WritableAtom } from "nanostores";
import { atom, computed } from "nanostores";
import type { VisualizerCameraRotationMode } from "../rendering/renderers/renderer-api";

const STORAGE_KEY = "nightfall-visualizer-settings";

export type VisualizerQualityPreset = "low" | "medium" | "high";

type VisualizerSettings = {
  highlightSelection: boolean;
  snapPointsEnabled: boolean;
  qualityPreset: VisualizerQualityPreset;
  darkness: number;
  cameraRotationMode: VisualizerCameraRotationMode;
  showOrbitTargetIndicator: boolean;
};

const DEFAULT_SETTINGS: VisualizerSettings = {
  highlightSelection: true,
  snapPointsEnabled: false,
  qualityPreset: "medium",
  darkness: 50,
  cameraRotationMode: "camera-locked",
  showOrbitTargetIndicator: false,
};

/**
 * Returns whether a stored value is a supported visualizer quality preset.
 */
function isVisualizerQualityPreset(
  value: unknown,
): value is VisualizerQualityPreset {
  return value === "low" || value === "medium" || value === "high";
}

/**
 * Returns whether a stored value is a supported camera rotation mode.
 */
function isVisualizerCameraRotationMode(
  value: unknown,
): value is VisualizerCameraRotationMode {
  return value === "camera-locked" || value === "center-locked";
}

/**
 * Merges persisted visualizer settings with current defaults and drops invalid fields.
 */
function sanitizeVisualizerSettings(value: unknown): VisualizerSettings {
  if (value === null || typeof value !== "object") {
    return DEFAULT_SETTINGS;
  }

  const parsed = value as Partial<VisualizerSettings>;
  return {
    darkness:
      typeof parsed.darkness === "number" && Number.isFinite(parsed.darkness)
        ? Math.max(0, Math.min(100, parsed.darkness))
        : DEFAULT_SETTINGS.darkness,
    highlightSelection:
      typeof parsed.highlightSelection === "boolean"
        ? parsed.highlightSelection
        : DEFAULT_SETTINGS.highlightSelection,
    snapPointsEnabled:
      typeof parsed.snapPointsEnabled === "boolean"
        ? parsed.snapPointsEnabled
        : DEFAULT_SETTINGS.snapPointsEnabled,
    qualityPreset: isVisualizerQualityPreset(parsed.qualityPreset)
      ? parsed.qualityPreset
      : DEFAULT_SETTINGS.qualityPreset,
    cameraRotationMode: isVisualizerCameraRotationMode(
      parsed.cameraRotationMode,
    )
      ? parsed.cameraRotationMode
      : DEFAULT_SETTINGS.cameraRotationMode,
    showOrbitTargetIndicator:
      typeof parsed.showOrbitTargetIndicator === "boolean"
        ? parsed.showOrbitTargetIndicator
        : DEFAULT_SETTINGS.showOrbitTargetIndicator,
  };
}

/**
 * Decodes persisted visualizer settings from localStorage.
 */
function decodeVisualizerSettings(value: string): VisualizerSettings {
  try {
    return sanitizeVisualizerSettings(JSON.parse(value));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const visualizerSettings = persistentAtom<VisualizerSettings>(
  STORAGE_KEY,
  DEFAULT_SETTINGS,
  {
    decode: decodeVisualizerSettings,
    encode: JSON.stringify,
  },
);

const initialSettings = visualizerSettings.get();
export const visualizerDarkness = atom(initialSettings.darkness);

export const visualizerHighlightSelection = atom<boolean>(
  initialSettings.highlightSelection,
);
export const visualizerSnapPointsEnabled = atom<boolean>(
  initialSettings.snapPointsEnabled,
);
export const visualizerQualityPreset = atom<VisualizerQualityPreset>(
  initialSettings.qualityPreset,
);
/**
 * Session-only quality applied by the `visualizer:beamQuality` diagnostic URL
 * parameter. It is never persisted and is dropped as soon as the user picks a
 * preset, so saved Settings stay authoritative.
 */
export const visualizerQualityOverride = atom<
  VisualizerQualityPreset | undefined
>(undefined);
/** Quality the renderer should use: the diagnostic override, else the saved preset. */
export const visualizerEffectiveQuality = computed(
  [visualizerQualityPreset, visualizerQualityOverride],
  (preset, override) => override ?? preset,
);
visualizerQualityPreset.listen(() => visualizerQualityOverride.set(undefined));
export const visualizerCameraRotationMode = atom<VisualizerCameraRotationMode>(
  initialSettings.cameraRotationMode,
);
export const visualizerShowOrbitTargetIndicator = atom<boolean>(
  initialSettings.showOrbitTargetIndicator,
);

let applyingPersistedSettings = false;

/**
 * Updates a field in the persisted visualizer settings object.
 */
function updateVisualizerSetting<Key extends keyof VisualizerSettings>(
  key: Key,
  value: VisualizerSettings[Key],
): void {
  if (applyingPersistedSettings) {
    return;
  }

  visualizerSettings.set({
    ...visualizerSettings.get(),
    [key]: value,
  });
}

/**
 * Keeps an exported field atom synchronized with the persisted settings atom.
 */
function syncVisualizerSetting<Key extends keyof VisualizerSettings>(
  key: Key,
  store: WritableAtom<VisualizerSettings[Key]>,
): void {
  store.listen((value) => {
    updateVisualizerSetting(key, value as VisualizerSettings[Key]);
  });
}

syncVisualizerSetting("highlightSelection", visualizerHighlightSelection);
syncVisualizerSetting("snapPointsEnabled", visualizerSnapPointsEnabled);
syncVisualizerSetting("qualityPreset", visualizerQualityPreset);
syncVisualizerSetting("darkness", visualizerDarkness);
syncVisualizerSetting("cameraRotationMode", visualizerCameraRotationMode);
syncVisualizerSetting(
  "showOrbitTargetIndicator",
  visualizerShowOrbitTargetIndicator,
);

visualizerSettings.listen((settings) => {
  applyingPersistedSettings = true;
  if (visualizerDarkness.get() !== settings.darkness)
    visualizerDarkness.set(settings.darkness);
  if (visualizerHighlightSelection.get() !== settings.highlightSelection) {
    visualizerHighlightSelection.set(settings.highlightSelection);
  }
  if (visualizerSnapPointsEnabled.get() !== settings.snapPointsEnabled) {
    visualizerSnapPointsEnabled.set(settings.snapPointsEnabled);
  }
  if (visualizerQualityPreset.get() !== settings.qualityPreset) {
    visualizerQualityPreset.set(settings.qualityPreset);
  }
  if (visualizerCameraRotationMode.get() !== settings.cameraRotationMode) {
    visualizerCameraRotationMode.set(settings.cameraRotationMode);
  }
  if (
    visualizerShowOrbitTargetIndicator.get() !==
    settings.showOrbitTargetIndicator
  ) {
    visualizerShowOrbitTargetIndicator.set(settings.showOrbitTargetIndicator);
  }
  applyingPersistedSettings = false;
});
