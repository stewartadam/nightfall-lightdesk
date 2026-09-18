// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { persistentAtom } from "@nanostores/persistent";
import type { WritableAtom } from "nanostores";
import { atom } from "nanostores";
import type { VisualizerCameraRotationMode } from "../rendering/renderers/renderer-api";

const STORAGE_KEY = "nightfall-visualizer-settings";

export type VisualizerQualityPreset = "low" | "medium" | "high";

type VisualizerSettings = {
  highlightSelection: boolean;
  snapPointsEnabled: boolean;
  qualityPreset: VisualizerQualityPreset;
  cameraRotationMode: VisualizerCameraRotationMode;
  showOrbitTargetIndicator: boolean;
};

const DEFAULT_SETTINGS: VisualizerSettings = {
  highlightSelection: true,
  snapPointsEnabled: false,
  qualityPreset: "medium",
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

export const visualizerHighlightSelection = atom<boolean>(
  initialSettings.highlightSelection,
);
export const visualizerSnapPointsEnabled = atom<boolean>(
  initialSettings.snapPointsEnabled,
);
export const visualizerQualityPreset = atom<VisualizerQualityPreset>(
  initialSettings.qualityPreset,
);
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
syncVisualizerSetting("cameraRotationMode", visualizerCameraRotationMode);
syncVisualizerSetting(
  "showOrbitTargetIndicator",
  visualizerShowOrbitTargetIndicator,
);

visualizerSettings.listen((settings) => {
  applyingPersistedSettings = true;
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
