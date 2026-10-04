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

test("stored layouts are snapshots independent of the active session", async () => {
  const storage = await importLayoutStorage();

  const stored = storage.storeCurrentLayout(
    createDockApi("stored"),
    "Board Op",
  );
  assert.ok(stored);
  assert.equal(storage.getActiveStoredLayoutId(), stored.id);
  assert.deepEqual(
    storage.getShowfilePanelLayouts().map((layout) => layout.name),
    ["Board Op"],
  );

  assert.equal(storage.saveLayout(createDockApi("session-edit")), true);
  assert.deepEqual(storage.loadLayout()?.layout, { grid: "session-edit" });
  assert.deepEqual(storage.getStoredLayout(stored.id)?.layout, {
    grid: "stored",
  });
});

/** Verifies committing a restored layout updates the session without aliasing the snapshot. */
test("commitActiveLayout records a restored layout as the active session", async () => {
  const storage = await importLayoutStorage();

  const stored = storage.storeCurrentLayout(createDockApi("stored"), "One");
  assert.ok(stored);
  assert.equal(storage.saveLayout(createDockApi("session-edit")), true);

  const restored = storage.getStoredLayout(stored.id);
  assert.ok(restored);
  assert.equal(storage.commitActiveLayout(stored.id, restored), true);
  assert.equal(storage.getActiveStoredLayoutId(), stored.id);
  assert.deepEqual(storage.loadLayout()?.layout, { grid: "stored" });

  (restored.layout as { grid: string }).grid = "mutated";
  assert.deepEqual(storage.loadLayout()?.layout, { grid: "stored" });
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
        group: { id: "edge-Clips", views: [] },
        size: 550,
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
        group: { id: "edge-Clips", views: [] },
        size: 550,
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

  assert.equal(edgeGroups.left.size, 550);
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
    storage.getShowfilePanelLayouts().map((layout) => layout.name),
    ["Showfile"],
  );
  assert.deepEqual(storage.getShowfilePanelLayouts(), showfileLayouts);
  assert.equal(storage.getActiveStoredLayoutId(), null);
});

/** Keeps the transient flag when the showfile's layouts are copied into local storage. */
test("transient layouts stay transient through showfile replacement", async () => {
  const storage = await importLayoutStorage();

  const stored = storage.storeCurrentLayout(createDockApi("lesson"), "Lesson");
  assert.ok(stored);
  const lesson = { ...stored, transient: true };
  assert.equal(storage.replaceStoredLayoutsFromShowfile([lesson]), true);
  assert.equal(storage.getStoredLayout(lesson.id)?.transient, true);
});

test("invalid layout store data falls back to an empty state", async () => {
  setTestStorageKey(LAYOUT_STORAGE_KEY, "{");

  const storage = await importLayoutStorage();

  assert.equal(storage.loadLayout(), null);
  assert.deepEqual(storage.getShowfilePanelLayouts(), []);
  assert.equal(storage.clearAllLayoutStorage(), true);

  assert.deepEqual(JSON.parse(getTestStorage()[LAYOUT_STORAGE_KEY]), {
    version: 2,
    activeLayoutId: null,
    sessionLayout: null,
    sessionShowfileName: null,
    layouts: [],
  });
});

/** Verifies a device's arrangement is only reused for the showfile it was made for. */
test("session layouts belong to the showfile they were saved for", async () => {
  const storage = await importLayoutStorage();
  const { persistCurrentShowfileName } = await import("./showfile-loading.js");

  persistCurrentShowfileName("tour");
  assert.equal(storage.saveLayout(createDockApi("session")), true);
  assert.equal(storage.hasSessionLayoutFor("tour"), true);
  assert.equal(storage.hasSessionLayoutFor("festival"), false);

  assert.equal(storage.clearLayout(), true);
  assert.equal(storage.hasSessionLayoutFor("tour"), false);
});
