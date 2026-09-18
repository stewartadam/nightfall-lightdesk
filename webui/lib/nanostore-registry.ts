// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { AnyStore } from "nanostores";
import * as fixtureLibraryStores from "../features/fixture-library/state/selection";
import * as fixturesPanelStores from "../features/fixtures/state/panel-settings";
import * as objectLibraryStores from "../features/object-library/state/selection";
import * as visualizerSettingsStores from "../features/visualizer/state/settings";
import * as appStores from "../state/appStores";
import * as settingsStores from "../state/settings";

export type StoreModuleExports = Record<string, unknown>;

export interface StoreModuleSource {
  exports: StoreModuleExports;
}

export interface NanostoreRegistryEntry {
  metricScope: string;
  name: string;
  store: AnyStore;
}

const STORE_MODULES: StoreModuleSource[] = [
  { exports: appStores },
  { exports: settingsStores },
  { exports: fixtureLibraryStores },
  { exports: fixturesPanelStores },
  { exports: objectLibraryStores },
  { exports: visualizerSettingsStores },
];

const METRIC_SCOPE_OVERRIDES: Record<string, string> = {
  cueDurationProfiles: "cue-durations",
};

/**
 * Determine whether a value has the runtime shape of a Nano Store.
 */
function isNanostore(value: unknown): value is AnyStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    "subscribe" in value &&
    typeof value.get === "function" &&
    typeof value.subscribe === "function"
  );
}

/**
 * Convert an exported store symbol into the log module/store name.
 */
function normalizeStoreName(exportName: string): string {
  return exportName.startsWith("$") ? exportName.slice(1) : exportName;
}

/** Converts an exported store symbol into its default metric scope name. */
function defaultMetricScope(exportName: string): string {
  return normalizeStoreName(exportName)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Collect exported Nano Stores from the configured store modules.
 */
export function collectNanostoreEntries(
  sources: StoreModuleSource[] = STORE_MODULES,
): NanostoreRegistryEntry[] {
  const storesByName = new Map<string, NanostoreRegistryEntry>();

  for (const source of sources) {
    for (const [exportName, value] of Object.entries(source.exports)) {
      if (!isNanostore(value)) continue;

      const name = normalizeStoreName(exportName);
      if (!storesByName.has(name)) {
        storesByName.set(name, {
          metricScope:
            METRIC_SCOPE_OVERRIDES[exportName] ??
            defaultMetricScope(exportName),
          name,
          store: value,
        });
      }
    }
  }

  return Array.from(storesByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
