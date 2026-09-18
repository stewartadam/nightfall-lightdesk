// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import {
  cleanTestStorage,
  getTestStorage,
  setTestStorageKey,
  useTestStorageEngine,
} from "@nanostores/persistent";

const STORAGE_KEY = "nightfall-visualizer-settings";

let importCounter = 0;

before(() => {
  useTestStorageEngine();
});

afterEach(() => {
  cleanTestStorage();
});

/**
 * Imports a fresh copy of the visualizer settings module for each persistence scenario.
 */
async function importVisualizerSettings() {
  importCounter += 1;
  return import(`./settings.js?case=${importCounter}`);
}

test("visualizer settings hydrate valid persisted values and default invalid fields", async () => {
  setTestStorageKey(
    STORAGE_KEY,
    JSON.stringify({
      cameraRotationMode: "center-locked",
      highlightSelection: false,
      qualityPreset: "ultra",
      showOrbitTargetIndicator: true,
      snapPointsEnabled: true,
    }),
  );

  const settings = await importVisualizerSettings();

  assert.equal(settings.visualizerCameraRotationMode.get(), "center-locked");
  assert.equal(settings.visualizerHighlightSelection.get(), false);
  assert.equal(settings.visualizerQualityPreset.get(), "medium");
  assert.equal(settings.visualizerShowOrbitTargetIndicator.get(), true);
  assert.equal(settings.visualizerSnapPointsEnabled.get(), true);
});

test("visualizer setting atoms persist updates into the legacy storage key", async () => {
  const settings = await importVisualizerSettings();

  settings.visualizerQualityPreset.set("high");
  settings.visualizerSnapPointsEnabled.set(true);

  const stored = JSON.parse(getTestStorage()[STORAGE_KEY]);

  assert.equal(stored.qualityPreset, "high");
  assert.equal(stored.snapPointsEnabled, true);
  assert.equal(stored.highlightSelection, true);
});
