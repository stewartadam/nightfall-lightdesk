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

const STORAGE_KEY = "nightfall-fixtures-panel-settings";

let importCounter = 0;

before(() => {
  useTestStorageEngine();
});

afterEach(() => {
  cleanTestStorage();
});

/**
 * Imports a fresh copy of the fixtures context module for each persistence scenario.
 */
async function importFixturesContext() {
  importCounter += 1;
  return import(`./panel-settings.js?case=${importCounter}`);
}

test("fixtures panel settings hydrate persisted values", async () => {
  setTestStorageKey(
    STORAGE_KEY,
    JSON.stringify({
      expandedFixtures: ["fixture-a", 12, "fixture-b"],
      showOnlyWithAttributes: true,
      showReleasedOutput: true,
    }),
  );

  const context = await importFixturesContext();

  assert.deepEqual(Array.from(context.fixturesExpandedSet.get()), [
    "fixture-a",
    "fixture-b",
  ]);
  assert.equal(context.fixturesShowOnlyWithAttributes.get(), true);
  assert.equal(context.fixturesShowReleasedOutput.get(), true);
});

test("fixtures panel setters persist updates into the legacy storage key", async () => {
  const context = await importFixturesContext();

  context.setFixturesExpandedSet(new Set(["fixture-a", "fixture-c"]));
  context.setFixturesShowOnlyWithAttributes(true);

  const stored = JSON.parse(getTestStorage()[STORAGE_KEY]);

  assert.deepEqual(stored.expandedFixtures, ["fixture-a", "fixture-c"]);
  assert.equal(stored.showOnlyWithAttributes, true);
  assert.equal(stored.showReleasedOutput, false);
});
