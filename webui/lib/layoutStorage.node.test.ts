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
import type { DockviewApi } from "dockview";

const LAYOUT_STORAGE_KEY = "nightfall-ui-layouts";

type LayoutStorageModule = typeof import("./layoutStorage");

let importCounter = 0;

before(() => {
  useTestStorageEngine();
});

afterEach(() => {
  cleanTestStorage();
});

/**
 * Imports a fresh copy of the layout storage module for each persistence scenario.
 */
async function importLayoutStorage(): Promise<LayoutStorageModule> {
  importCounter += 1;
  return import(
    `./layoutStorage.js?case=${importCounter}`
  ) as Promise<LayoutStorageModule>;
}

/**
 * Creates a minimal Dockview API object for layout serialization tests.
 */
function createDockApi(layoutId: string): DockviewApi {
  return {
    toJSON: () => ({ grid: layoutId }),
    panels: [
      {
        id: `panel-${layoutId}`,
        title: `Panel ${layoutId}`,
        params: { layoutId },
      },
    ],
  } as unknown as DockviewApi;
}

test("saveLayout stores and clears the active session layout", async () => {
  const storage = await importLayoutStorage();

  assert.equal(storage.loadLayout(), null);

  assert.equal(storage.saveLayout(createDockApi("session")), true);
  assert.deepEqual(storage.loadLayout()?.layout, { grid: "session" });

  assert.equal(storage.clearLayout(), true);
  assert.equal(storage.loadLayout(), null);
});

test("stored layouts are snapshots loaded into the active session", async () => {
  const storage = await importLayoutStorage();

  const stored = storage.storeCurrentLayout(
    createDockApi("stored"),
    "Board Op",
  );
  assert.ok(stored);
  assert.equal(storage.getActiveStoredLayoutId(), stored.id);
  assert.deepEqual(
    storage.listStoredLayouts().map((layout) => layout.name),
    ["Board Op"],
  );

  assert.equal(storage.saveLayout(createDockApi("session-edit")), true);
  assert.deepEqual(storage.loadLayout()?.layout, { grid: "session-edit" });
  assert.deepEqual(storage.getStoredLayout(stored.id)?.layout, {
    grid: "stored",
  });

  const loaded = storage.loadStoredLayout(stored.id);
  assert.deepEqual(loaded?.layout, { grid: "stored" });
  assert.deepEqual(storage.loadLayout()?.layout, { grid: "stored" });
  assert.deepEqual(storage.getStoredLayout(stored.id)?.layout, {
    grid: "stored",
  });
});

test("legacy Dockview session layouts gain hidden default edge groups", async () => {
  const legacyLayout = {
    activeGroup: "group-main",
    grid: {
      root: {
        data: [{ data: { id: "group-main", views: [] }, size: 100 }],
        type: "branch",
      },
    },
    panels: {},
  };
  setTestStorageKey(
    LAYOUT_STORAGE_KEY,
    JSON.stringify({
      activeLayoutId: null,
      layouts: [],
      sessionLayout: {
        layout: legacyLayout,
        panels: [],
        version: 2,
      },
      version: 2,
    }),
  );

  const storage = await importLayoutStorage();

  assert.deepEqual(storage.loadLayout()?.layout, {
    ...legacyLayout,
    edgeGroups: {
      bottom: {
        collapsed: true,
        group: { id: "edge-Console", views: [] },
        size: 260,
        visible: false,
      },
      left: {
        collapsed: true,
        group: { id: "edge-Programmer", views: [] },
        size: 360,
        visible: false,
      },
      right: {
        collapsed: true,
        group: { id: "edge-Properties", views: [] },
        size: 340,
        visible: false,
      },
    },
  });
});

test("edge group migration preserves existing stored edge group state", async () => {
  const rightEdgeGroup = {
    collapsed: false,
    group: {
      activeView: "panel-PropertiesInspector",
      id: "edge-Properties",
      views: ["panel-PropertiesInspector"],
    },
    size: 420,
    visible: true,
  };
  const partialEdgeLayout = {
    activeGroup: "group-main",
    edgeGroups: {
      right: rightEdgeGroup,
    },
    grid: {
      root: {
        data: [{ data: { id: "group-main", views: [] }, size: 100 }],
        type: "branch",
      },
    },
    panels: {
      "panel-PropertiesInspector": {
        id: "panel-PropertiesInspector",
      },
    },
  };
  setTestStorageKey(
    LAYOUT_STORAGE_KEY,
    JSON.stringify({
      activeLayoutId: "stored-layout",
      layouts: [
        {
          createdAt: 1,
          id: "stored-layout",
          layout: partialEdgeLayout,
          name: "Stored",
          panels: [],
          updatedAt: 2,
          version: 2,
        },
      ],
      sessionLayout: null,
      version: 2,
    }),
  );

  const storage = await importLayoutStorage();

  assert.deepEqual(storage.getStoredLayout("stored-layout")?.layout, {
    ...partialEdgeLayout,
    edgeGroups: {
      bottom: {
        collapsed: true,
        group: { id: "edge-Console", views: [] },
        size: 260,
        visible: false,
      },
      left: {
        collapsed: true,
        group: { id: "edge-Programmer", views: [] },
        size: 360,
        visible: false,
      },
      right: rightEdgeGroup,
    },
  });
});

test("edge group migration fills missing stored edge group sizes", async () => {
  const partialEdgeLayout = {
    activeGroup: "group-main",
    edgeGroups: {
      left: {
        collapsed: false,
        group: {
          activeView: "panel-ProgrammerGrid",
          id: "edge-Programmer",
          views: ["panel-ProgrammerGrid"],
        },
        visible: true,
      },
      right: {
        collapsed: false,
        group: {
          activeView: "panel-PropertiesInspector",
          id: "edge-Properties",
          views: ["panel-PropertiesInspector"],
        },
        size: Number.NaN,
        visible: true,
      },
    },
    grid: {
      root: {
        data: [{ data: { id: "group-main", views: [] }, size: 100 }],
        type: "branch",
      },
    },
    panels: {},
  };
  setTestStorageKey(
    LAYOUT_STORAGE_KEY,
    JSON.stringify({
      activeLayoutId: null,
      layouts: [],
      sessionLayout: {
        layout: partialEdgeLayout,
        panels: [],
        version: 2,
      },
      version: 2,
    }),
  );

  const storage = await importLayoutStorage();
  const loadedLayout = storage.loadLayout();
  assert.ok(loadedLayout, "expected migrated session layout");
  const edgeGroups = (loadedLayout.layout as any).edgeGroups;

  assert.equal(edgeGroups.left.size, 360);
  assert.equal(edgeGroups.right.size, 340);
});

/**
 * Verifies layout capture keeps Dockview's current edge shell size when the serialized layout is stale.
 */
test("stored layouts capture live edge shell sizes over stale Dockview JSON", async () => {
  const storage = await importLayoutStorage();
  const staleLayout = {
    activeGroup: "group-main",
    edgeGroups: {
      right: {
        collapsed: false,
        group: {
          activeView: "panel-PropertiesInspector",
          id: "edge-Properties",
          views: ["panel-PropertiesInspector"],
        },
        size: 260,
        visible: true,
      },
    },
    grid: {
      root: {
        data: [{ data: { id: "group-main", views: [] }, size: 100 }],
        type: "branch",
      },
    },
    panels: {
      "panel-PropertiesInspector": {
        id: "panel-PropertiesInspector",
      },
    },
  };
  const api = {
    ...createDockApi("live-edge"),
    component: {
      _shellManager: {
        toJSON: () => ({
          right: {
            collapsed: false,
            size: 520,
            visible: true,
          },
        }),
      },
    },
    toJSON: () => staleLayout,
  } as unknown as DockviewApi;

  const stored = storage.storeCurrentLayout(api, "Live Edge");

  assert.ok(stored);
  assert.equal((stored.layout as any).edgeGroups.right.size, 520);
  assert.deepEqual((stored.layout as any).edgeGroups.right.group, {
    activeView: "panel-PropertiesInspector",
    id: "edge-Properties",
    views: ["panel-PropertiesInspector"],
  });
});

test("overwrite, rename, duplicate, and delete update named layouts", async () => {
  const storage = await importLayoutStorage();

  const stored = storage.storeCurrentLayout(createDockApi("one"), "One");
  assert.ok(stored);

  const overwritten = storage.overwriteStoredLayout(
    createDockApi("two"),
    stored.id,
  );
  assert.equal(overwritten?.name, "One");
  assert.deepEqual(storage.getStoredLayout(stored.id)?.layout, { grid: "two" });

  const renamed = storage.renameStoredLayout(stored.id, "Primary");
  assert.equal(renamed?.name, "Primary");

  const duplicate = storage.duplicateStoredLayout(stored.id, "Copy");
  assert.ok(duplicate);
  assert.notEqual(duplicate.id, stored.id);
  assert.deepEqual(duplicate.layout, { grid: "two" });

  assert.deepEqual(
    storage.listStoredLayouts().map((layout) => layout.name),
    ["Copy", "Primary"],
  );

  assert.equal(storage.deleteStoredLayout(stored.id), true);
  assert.deepEqual(
    storage.listStoredLayouts().map((layout) => layout.name),
    ["Copy"],
  );

  assert.equal(storage.clearStoredLayouts(), true);
  assert.deepEqual(storage.listStoredLayouts(), []);
});

test("showfile panel layouts replace only named layout storage", async () => {
  const storage = await importLayoutStorage();

  const local = storage.storeCurrentLayout(createDockApi("local"), "Local");
  assert.ok(local);
  assert.equal(storage.saveLayout(createDockApi("session")), true);

  const showfileLayouts = [
    {
      ...storage.getShowfilePanelLayouts()[0],
      id: "showfile-layout",
      name: "Showfile",
      layout: { grid: "showfile" },
    },
  ];

  assert.equal(storage.replaceStoredLayoutsFromShowfile(showfileLayouts), true);
  assert.deepEqual(storage.loadLayout()?.layout, { grid: "session" });
  assert.deepEqual(
    storage.listStoredLayouts().map((layout) => layout.name),
    ["Showfile"],
  );
  assert.deepEqual(storage.getShowfilePanelLayouts(), showfileLayouts);
  assert.equal(storage.getActiveStoredLayoutId(), null);
});

test("invalid layout store data falls back to an empty state", async () => {
  setTestStorageKey(LAYOUT_STORAGE_KEY, "{");

  const storage = await importLayoutStorage();

  assert.equal(storage.loadLayout(), null);
  assert.deepEqual(storage.listStoredLayouts(), []);
  assert.equal(storage.clearAllLayoutStorage(), true);

  assert.deepEqual(JSON.parse(getTestStorage()[LAYOUT_STORAGE_KEY]), {
    version: 2,
    activeLayoutId: null,
    sessionLayout: null,
    layouts: [],
  });
});
