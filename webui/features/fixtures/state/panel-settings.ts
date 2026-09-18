// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Fixtures panel state management using nanostores.
 * Provides shared state with localStorage persistence for UI preferences.
 */

import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";
import { getLogger } from "../../../lib/logger";
import { setStoreAction } from "../../../lib/nanostore-action";

const log = getLogger(import.meta.url);

const STORAGE_KEY = "nightfall-fixtures-panel-settings";

interface FixturesPanelSettings {
  showOnlyWithAttributes: boolean;
  expandedFixtures: string[];
  showReleasedOutput: boolean;
}

const DEFAULT_SETTINGS: FixturesPanelSettings = {
  showOnlyWithAttributes: false,
  expandedFixtures: [],
  showReleasedOutput: false,
};

/**
 * Merges persisted fixture panel settings with current defaults and drops invalid fields.
 */
function sanitizeFixturesPanelSettings(value: unknown): FixturesPanelSettings {
  if (value === null || typeof value !== "object") {
    return DEFAULT_SETTINGS;
  }

  const parsed = value as Partial<FixturesPanelSettings>;
  return {
    showOnlyWithAttributes:
      typeof parsed.showOnlyWithAttributes === "boolean"
        ? parsed.showOnlyWithAttributes
        : DEFAULT_SETTINGS.showOnlyWithAttributes,
    expandedFixtures: Array.isArray(parsed.expandedFixtures)
      ? parsed.expandedFixtures.filter(
          (fixtureUid): fixtureUid is string => typeof fixtureUid === "string",
        )
      : DEFAULT_SETTINGS.expandedFixtures,
    showReleasedOutput:
      typeof parsed.showReleasedOutput === "boolean"
        ? parsed.showReleasedOutput
        : DEFAULT_SETTINGS.showReleasedOutput,
  };
}

/**
 * Decodes persisted fixture panel settings from localStorage.
 */
function decodeFixturesPanelSettings(value: string): FixturesPanelSettings {
  try {
    return sanitizeFixturesPanelSettings(JSON.parse(value));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const fixturesPanelSettings = persistentAtom<FixturesPanelSettings>(
  STORAGE_KEY,
  DEFAULT_SETTINGS,
  {
    decode: decodeFixturesPanelSettings,
    encode: JSON.stringify,
  },
);

const initialSettings = fixturesPanelSettings.get();

export const fixturesShowOnlyWithAttributes = atom<boolean>(
  initialSettings.showOnlyWithAttributes,
);
export const fixturesExpandedSet = atom<Set<string>>(
  new Set(initialSettings.expandedFixtures),
);
export const fixturesShowReleasedOutput = atom<boolean>(
  initialSettings.showReleasedOutput,
);

/**
 * Persists a snapshot of the primary in-memory fixture panel atoms.
 */
function persistSettings(): void {
  try {
    fixturesPanelSettings.set({
      showOnlyWithAttributes: fixturesShowOnlyWithAttributes.get(),
      expandedFixtures: Array.from(fixturesExpandedSet.get()),
      showReleasedOutput: fixturesShowReleasedOutput.get(),
    });
  } catch (error) {
    log.warn("Failed to persist fixtures panel settings", error);
  }
}

fixturesShowOnlyWithAttributes.subscribe(persistSettings);
fixturesExpandedSet.subscribe(persistSettings);
fixturesShowReleasedOutput.subscribe(persistSettings);

/**
 * Updates the fixture-panel attribute filter while preserving functional setter semantics.
 */
export function setFixturesShowOnlyWithAttributes(
  enabled: boolean | ((prev: boolean) => boolean),
): void {
  if (typeof enabled === "function") {
    setStoreAction(
      fixturesShowOnlyWithAttributes,
      "Set Fixtures Attribute Filter",
      enabled(fixturesShowOnlyWithAttributes.get()),
    );
  } else {
    setStoreAction(
      fixturesShowOnlyWithAttributes,
      "Set Fixtures Attribute Filter",
      enabled,
    );
  }
}

/**
 * Toggles whether a fixture row is expanded in the fixtures panel tree.
 */
export function toggleFixtureExpanded(uid: string): void {
  const current = fixturesExpandedSet.get();
  const next = new Set(current);
  if (next.has(uid)) {
    next.delete(uid);
  } else {
    next.add(uid);
  }
  setStoreAction(fixturesExpandedSet, "Toggle Fixture Expanded", next);
}

/**
 * Replaces the expanded fixture set while preserving functional setter semantics.
 *
 * @lintignore
 */
export function setFixturesExpandedSet(
  uids: Set<string> | ((prev: Set<string>) => Set<string>),
): void {
  if (typeof uids === "function") {
    setStoreAction(
      fixturesExpandedSet,
      "Set Fixtures Expanded Set",
      uids(fixturesExpandedSet.get()),
    );
  } else {
    setStoreAction(fixturesExpandedSet, "Set Fixtures Expanded Set", uids);
  }
}

/**
 * Updates whether released output values are shown in the fixtures panel.
 */
export function setFixturesShowReleasedOutput(
  enabled: boolean | ((prev: boolean) => boolean),
): void {
  if (typeof enabled === "function") {
    setStoreAction(
      fixturesShowReleasedOutput,
      "Set Fixtures Released Output",
      enabled(fixturesShowReleasedOutput.get()),
    );
  } else {
    setStoreAction(
      fixturesShowReleasedOutput,
      "Set Fixtures Released Output",
      enabled,
    );
  }
}
