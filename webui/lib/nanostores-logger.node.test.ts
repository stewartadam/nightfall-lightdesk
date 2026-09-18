// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { buildLogger } from "@nanostores/logger";
import { atom } from "nanostores";
import { configure } from "./logger";
import { setStoreAction } from "./nanostore-action";
import { collectNanostoreEntries } from "./nanostore-registry";
import { createNanostoresLoggerController } from "./nanostores-logger";

/**
 * Create a controller backed by fake stores and a counting buildLogger stub.
 */
function createHarness() {
  const builds: string[] = [];
  const destroys: string[] = [];
  const stores = [
    { name: "fixtures", store: atom(0) },
    { name: "cues", store: atom(0) },
  ];
  const buildStoreLogger: typeof buildLogger = (
    _store,
    storeName,
    _events,
    _opts,
  ) => {
    builds.push(storeName);
    return () => {
      destroys.push(storeName);
    };
  };

  const controller = createNanostoresLoggerController({
    buildStoreLogger,
    stores,
  });

  return { builds, controller, destroys };
}

test("collectNanostoreEntries normalizes names and metric scopes", () => {
  const entries = collectNanostoreEntries([
    {
      exports: {
        $settings: atom(0),
        cueDurationProfiles: atom(0),
        dmxUniverseData: atom(0),
        notAStore: () => undefined,
      },
    },
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["cueDurationProfiles", "dmxUniverseData", "settings"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.metricScope),
    ["cue-durations", "dmx-universe-data", "settings"],
  );
});

test("default info config installs no nanostores subscriptions", () => {
  configure("info", false);
  const harness = createHarness();

  assert.deepEqual(harness.builds, []);
  assert.deepEqual(harness.controller.activeStoreNames(), []);

  harness.controller.destroy();
  configure("info", false);
});

test("nanostores root trace enables all registered stores", () => {
  configure("info,nanostores=trace", false);
  const harness = createHarness();

  assert.deepEqual(harness.builds.sort(), ["cues", "fixtures"]);
  assert.deepEqual(harness.controller.activeStoreNames(), ["cues", "fixtures"]);

  harness.controller.destroy();
  configure("info", false);
});

test("store-specific trace enables only the targeted store", () => {
  configure("info,nanostores:fixtures=trace", false);
  const harness = createHarness();

  assert.deepEqual(harness.builds, ["fixtures"]);
  assert.deepEqual(harness.controller.activeStoreNames(), ["fixtures"]);

  harness.controller.destroy();
  configure("info", false);
});

test("clearing config destroys active nanostores subscriptions", () => {
  configure("info,nanostores=trace", false);
  const harness = createHarness();

  configure("info", false);

  assert.deepEqual(harness.controller.activeStoreNames(), []);
  assert.deepEqual(harness.destroys.sort(), ["cues", "fixtures"]);

  harness.controller.destroy();
  configure("info", false);
});

test("enabled store changes render styled console groups", () => {
  configure("info,nanostores:fixtures=trace", false);
  const store = atom(0);
  const groups: unknown[][] = [];
  const logs: unknown[][] = [];
  let groupEndCount = 0;
  const originalGroupCollapsed = console.groupCollapsed;
  const originalGroupEnd = console.groupEnd;
  const originalLog = console.log;

  console.groupCollapsed = (...args: unknown[]) => {
    groups.push(args);
  };
  console.groupEnd = () => {
    groupEndCount++;
  };
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  const controller = createNanostoresLoggerController({
    stores: [{ name: "fixtures", store }],
  });

  try {
    store.set(1);

    assert.equal(groups.length, 1);
    assert.match(
      String(groups[0]?.[0]),
      /𝖓.*change.*fixtures.*store was changed/,
    );
    assert.equal(logs.length, 1);
    assert.match(String(logs[0]?.[0]), /value.*0 → 1/);
    assert.equal(groupEndCount, 1);
  } finally {
    controller.destroy();
    console.groupCollapsed = originalGroupCollapsed;
    console.groupEnd = originalGroupEnd;
    console.log = originalLog;
    configure("info", false);
  }
});

test("annotated store changes render action groups", () => {
  configure("info,nanostores:fixtures=trace", false);
  const store = atom(0);
  const groups: unknown[][] = [];
  const logs: unknown[][] = [];
  let groupEndCount = 0;
  const originalGroupCollapsed = console.groupCollapsed;
  const originalGroupEnd = console.groupEnd;
  const originalLog = console.log;

  console.groupCollapsed = (...args: unknown[]) => {
    groups.push(args);
  };
  console.groupEnd = () => {
    groupEndCount++;
  };
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  const controller = createNanostoresLoggerController({
    stores: [{ name: "fixtures", store }],
  });

  try {
    setStoreAction(store, "Receive FixtureDefinitions", 1);

    assert.equal(groups.length, 2);
    assert.match(
      String(groups[0]?.[0]),
      /𝖓.*action.*fixtures.*store was changed by action.*Receive FixtureDefinitions/,
    );
    assert.match(String(groups[1]?.[0]), /change.*fixtures.*store was changed/);
    assert.equal(
      logs.some((entry) => String(entry[0]).includes("arguments")),
      true,
    );
    assert.equal(
      logs.some((entry) => String(entry[0]).includes("0 → 1")),
      true,
    );
    assert.equal(groupEndCount, 2);
  } finally {
    controller.destroy();
    console.groupCollapsed = originalGroupCollapsed;
    console.groupEnd = originalGroupEnd;
    console.log = originalLog;
    configure("info", false);
  }
});
