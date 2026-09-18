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
import {
  changeCrudPanelViewMode,
  loadCrudPanelViewMode,
} from "./crud-panel-view-mode";

before(() => {
  useTestStorageEngine();
});

afterEach(() => {
  cleanTestStorage();
});

/** Verifies list-mode transition callbacks run once and persistence is updated. */
test("changeCrudPanelViewMode runs the list hook when transitioning to list mode", () => {
  let nextMode = "grid";
  let enterListCalls = 0;

  changeCrudPanelViewMode(
    "fx-list",
    "grid",
    "list",
    (mode) => {
      nextMode = mode;
    },
    {
      onEnterListMode: () => {
        enterListCalls += 1;
      },
    },
  );

  assert.equal(nextMode, "list");
  assert.equal(enterListCalls, 1);
  assert.equal(loadCrudPanelViewMode("fx-list"), "list");
  assert.equal(
    getTestStorage()["nightfall-crud-panel-view-mode:fx-list"],
    "list",
  );
});

/** Verifies grid-mode transition callbacks run once and persistence is updated. */
test("changeCrudPanelViewMode runs the grid hook when transitioning to grid mode", () => {
  let nextMode = "list";
  let enterGridCalls = 0;

  changeCrudPanelViewMode(
    "clips-list",
    "list",
    "grid",
    (mode) => {
      nextMode = mode;
    },
    {
      onEnterGridMode: () => {
        enterGridCalls += 1;
      },
    },
  );

  assert.equal(nextMode, "grid");
  assert.equal(enterGridCalls, 1);
  assert.equal(loadCrudPanelViewMode("clips-list"), "grid");
  assert.equal(
    getTestStorage()["nightfall-crud-panel-view-mode:clips-list"],
    "grid",
  );
});

/** Verifies transition callbacks are skipped when the requested mode is already active. */
test("changeCrudPanelViewMode skips transition hooks when mode is unchanged", () => {
  let enterGridCalls = 0;
  let enterListCalls = 0;

  changeCrudPanelViewMode("fx-list", "list", "list", () => {}, {
    onEnterListMode: () => {
      enterListCalls += 1;
    },
    onEnterGridMode: () => {
      enterGridCalls += 1;
    },
  });
  changeCrudPanelViewMode("fx-list", "grid", "grid", () => {}, {
    onEnterListMode: () => {
      enterListCalls += 1;
    },
    onEnterGridMode: () => {
      enterGridCalls += 1;
    },
  });

  assert.equal(enterGridCalls, 0);
  assert.equal(enterListCalls, 0);
});

/** Verifies invalid persisted view-mode values fall back to the requested default. */
test("loadCrudPanelViewMode falls back when persisted value is invalid", () => {
  setTestStorageKey("nightfall-crud-panel-view-mode:fx-list", "cards");

  assert.equal(loadCrudPanelViewMode("fx-list"), "grid");
  assert.equal(loadCrudPanelViewMode("fx-list", "list"), "list");
});
