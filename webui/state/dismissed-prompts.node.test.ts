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

const STORAGE_KEY = "nightfall-dismissed-prompts";

let importCounter = 0;

before(() => {
  useTestStorageEngine();
});

afterEach(() => {
  cleanTestStorage();
});

/** Imports a fresh copy of the module so it hydrates from the current test storage. */
async function importDismissedPrompts() {
  importCounter += 1;
  return import(`./dismissed-prompts.js?case=${importCounter}`);
}

/** Ticking "Don't show this again" hides the prompt, and unticking it shows it again. */
test("a prompt can be turned off and back on", async () => {
  const prompts = await importDismissedPrompts();
  assert.equal(prompts.isPromptDismissed("midi-device-detected"), false);

  prompts.setPromptDismissed("midi-device-detected", true);
  prompts.setPromptDismissed("midi-device-detected", true);
  assert.equal(prompts.isPromptDismissed("midi-device-detected"), true);
  assert.deepEqual(JSON.parse(getTestStorage()[STORAGE_KEY]), [
    "midi-device-detected",
  ]);

  prompts.setPromptDismissed("midi-device-detected", false);
  assert.equal(prompts.isPromptDismissed("midi-device-detected"), false);
});

/** The settings reset brings back every prompt turned off on this device. */
test("reset shows every dismissed prompt again", async () => {
  setTestStorageKey(STORAGE_KEY, JSON.stringify(["midi-device-detected"]));
  const prompts = await importDismissedPrompts();
  assert.equal(prompts.isPromptDismissed("midi-device-detected"), true);

  prompts.resetDismissedPrompts();
  assert.deepEqual(prompts.dismissedPrompts.get(), []);
  assert.equal(prompts.isPromptDismissed("midi-device-detected"), false);
});

/**
 * Storage holding something other than a list of ids hides nothing instead of failing, and ids
 * of prompts this build does not have are not counted as hidden.
 */
test("malformed or stale storage hides no prompts", async () => {
  setTestStorageKey(STORAGE_KEY, "not json");
  const garbled = await importDismissedPrompts();
  assert.deepEqual(garbled.dismissedPrompts.get(), []);

  setTestStorageKey(STORAGE_KEY, JSON.stringify({ midi: true }));
  const prompts = await importDismissedPrompts();
  assert.deepEqual(prompts.dismissedPrompts.get(), []);

  setTestStorageKey(
    STORAGE_KEY,
    JSON.stringify(["midi-device-detected", 4, "retired-prompt"]),
  );
  const mixed = await importDismissedPrompts();
  assert.deepEqual(mixed.dismissedPrompts.get(), ["midi-device-detected"]);
});
