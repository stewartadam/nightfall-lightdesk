// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_LINE_PANEL_SHORTCUT } from "../features/command-line/panels/command-line.definition";
import { panelDefinitionByName } from "./panel-definitions";
import {
  getPanelOpenShortcut,
  openOrFocusPanel,
  openOrFocusPanelDefinition,
  type PanelOpenDockApi,
  panelOpenPlacementFromExecutionContext,
  panelOpenPlacementFromModifiers,
  panelOpenPlacementLabel,
} from "./panel-open-command";

type AddedPanelParams = Parameters<PanelOpenDockApi["addPanel"]>[0];

/** Creates the smallest Dockview API mock needed by panel-opening tests. */
function createDockApi(
  overrides: Partial<PanelOpenDockApi> = {},
): PanelOpenDockApi {
  return {
    activeGroup: { id: "group-active", height: 200, width: 300 },
    activePanel: {
      id: "panel-active",
      focus: () => {},
    },
    getPanel: () => undefined,
    addPanel: () => {},
    ...overrides,
  };
}

test("maps CommandLine panel to shift-backquote shortcut", () => {
  assert.equal(
    getPanelOpenShortcut("CommandLine"),
    COMMAND_LINE_PANEL_SHORTCUT,
  );
  assert.equal(getPanelOpenShortcut("FixtureGrid"), undefined);
});

test("maps palette modifiers to placement requests", () => {
  assert.equal(panelOpenPlacementFromModifiers(undefined), "default");
  assert.equal(
    panelOpenPlacementFromModifiers({ ctrlKey: true }),
    "group-left",
  );
  assert.equal(
    panelOpenPlacementFromModifiers({ ctrlKey: true, shiftKey: true }),
    "group-right",
  );
  assert.equal(
    panelOpenPlacementFromModifiers({ altKey: true }),
    "split-bottom",
  );
  assert.equal(
    panelOpenPlacementFromModifiers({ altKey: true, shiftKey: true }),
    "split-top",
  );
  assert.equal(panelOpenPlacementFromModifiers({ metaKey: true }), "row-below");
  assert.equal(
    panelOpenPlacementFromModifiers({ metaKey: true, shiftKey: true }),
    "row-above",
  );
  assert.equal(
    panelOpenPlacementFromModifiers({ altKey: true, metaKey: true }),
    "split-right",
  );
  assert.equal(
    panelOpenPlacementFromModifiers({
      altKey: true,
      metaKey: true,
      shiftKey: true,
    }),
    "split-left",
  );
});

test("labels modifier-requested panel placements", () => {
  assert.equal(panelOpenPlacementLabel("default"), undefined);
  assert.equal(panelOpenPlacementLabel("group-left"), "new group right");
  assert.equal(panelOpenPlacementLabel("group-right"), "new group right");
  assert.equal(panelOpenPlacementLabel("row-above"), "new row above");
  assert.equal(panelOpenPlacementLabel("row-below"), "new row below");
  assert.equal(panelOpenPlacementLabel("split-top"), "split above");
  assert.equal(panelOpenPlacementLabel("split-bottom"), "split below");
  assert.equal(panelOpenPlacementLabel("split-left"), "split left");
  assert.equal(panelOpenPlacementLabel("split-right"), "split right");
});

test("only command palette activation can request placement modifiers", () => {
  assert.equal(
    panelOpenPlacementFromExecutionContext({
      source: "shortcut",
      event: { ctrlKey: true },
    }),
    "default",
  );
  assert.equal(
    panelOpenPlacementFromExecutionContext({
      source: "palette",
      event: { ctrlKey: true },
    }),
    "group-left",
  );
});

test("openOrFocusPanel focuses existing panel when present", () => {
  let focusCalls = 0;
  let addCalls = 0;

  const api = createDockApi({
    getPanel: (id) =>
      id === "panel-CommandLine"
        ? {
            id,
            focus: () => {
              focusCalls += 1;
            },
          }
        : undefined,
    addPanel: () => {
      addCalls += 1;
    },
  });

  const result = openOrFocusPanel(
    api,
    "panel-CommandLine",
    "CommandLine",
    "Console",
  );

  assert.equal(result, "focused");
  assert.equal(focusCalls, 1);
  assert.equal(addCalls, 0);
});

/** Verifies edge-docked singleton panels are revealed before focus returns. */
test("openOrFocusPanel expands edge group for existing edge panel", () => {
  let focusCalls = 0;
  let expandCalls = 0;

  const api = createDockApi({
    getPanel: (id) =>
      id === "panel-CommandLine"
        ? {
            id,
            api: {
              location: {
                position: "bottom",
                type: "edge",
              },
            },
            focus: () => {
              focusCalls += 1;
            },
          }
        : undefined,
    getEdgeGroup: (position) =>
      position === "bottom"
        ? {
            expand: () => {
              expandCalls += 1;
            },
          }
        : undefined,
  });

  const result = openOrFocusPanel(
    api,
    "panel-CommandLine",
    "CommandLine",
    "Console",
  );

  assert.equal(result, "focused");
  assert.equal(expandCalls, 1);
  assert.equal(focusCalls, 1);
});

test("openOrFocusPanel opens panel when not present", () => {
  const addedPanels: AddedPanelParams[] = [];

  const api = createDockApi({
    addPanel: (params) => {
      addedPanels.push(params);
    },
  });

  const result = openOrFocusPanel(
    api,
    "panel-CommandLine",
    "CommandLine",
    "Console",
  );

  assert.equal(result, "opened");
  assert.deepEqual(addedPanels[0], {
    id: "panel-CommandLine",
    component: "CommandLine",
    title: "Console",
    params: {},
    position: undefined,
  });
});

/** Verifies definition-based opens use source-of-truth panel identity fields. */
test("openOrFocusPanelDefinition opens panel from shared definition", () => {
  const addedPanels: AddedPanelParams[] = [];

  const api = createDockApi({
    addPanel: (params) => {
      addedPanels.push(params);
    },
  });

  const result = openOrFocusPanelDefinition(
    api,
    panelDefinitionByName("GroupsPanel"),
  );

  assert.equal(result, "opened");
  assert.deepEqual(addedPanels[0], {
    id: "panel-Groups",
    component: "GroupsPanel",
    title: "Groups",
    params: {},
    position: undefined,
  });
});

test("openOrFocusPanel opens neighboring groups beside the active group", () => {
  const addedPanels: AddedPanelParams[] = [];

  const api = createDockApi({
    addPanel: (params) => {
      addedPanels.push(params);
    },
  });

  const result = openOrFocusPanel(
    api,
    "panel-Patch",
    "Patch",
    "Patch",
    "group-left",
  );

  assert.equal(result, "opened");
  assert.deepEqual(addedPanels[0], {
    id: "panel-Patch",
    component: "Patch",
    title: "Patch",
    params: {},
    position: {
      direction: "right",
      referenceGroup: "group-active",
    },
  });
});

test("openOrFocusPanel opens neighboring rows around the active group", () => {
  const addedPanels: AddedPanelParams[] = [];

  const api = createDockApi({
    addPanel: (params) => {
      addedPanels.push(params);
    },
  });

  const result = openOrFocusPanel(
    api,
    "panel-Patch",
    "Patch",
    "Patch",
    "row-below",
  );

  assert.equal(result, "opened");
  assert.deepEqual(addedPanels[0]?.position, {
    direction: "below",
  });
  assert.equal(addedPanels[0]?.initialHeight, undefined);
  assert.equal(addedPanels[0]?.initialWidth, undefined);
});

test("openOrFocusPanel splits the current group horizontally", () => {
  const addedPanels: AddedPanelParams[] = [];
  const resizeCalls: Array<{ height?: number; width?: number }> = [];
  const activeGroup = {
    id: "group-active",
    api: {
      setSize: (size: { height?: number; width?: number }) =>
        resizeCalls.push(size),
    },
    height: 200,
    width: 300,
  };
  const openedGroup = {
    id: "group-opened",
    api: {
      setSize: (size: { height?: number; width?: number }) =>
        resizeCalls.push(size),
    },
    height: 200,
    width: 300,
  };

  const api = createDockApi({
    activeGroup,
    addPanel: (params) => {
      addedPanels.push(params);
      return { id: params.id, focus: () => {}, group: openedGroup };
    },
  });

  const result = openOrFocusPanel(
    api,
    "panel-Patch",
    "Patch",
    "Patch",
    "split-bottom",
  );

  assert.equal(result, "opened");
  assert.deepEqual(addedPanels[0]?.position, {
    direction: "below",
    referenceGroup: "group-active",
  });
  assert.equal(addedPanels[0]?.initialHeight, 100);
  assert.equal(addedPanels[0]?.initialWidth, undefined);
  assert.deepEqual(resizeCalls, [{ height: 100 }, { height: 100 }]);
});

test("openOrFocusPanel splits the current group vertically", () => {
  const addedPanels: AddedPanelParams[] = [];
  const resizeCalls: Array<{ height?: number; width?: number }> = [];
  const activeGroup = {
    id: "group-active",
    api: {
      setSize: (size: { height?: number; width?: number }) =>
        resizeCalls.push(size),
    },
    height: 200,
    width: 300,
  };
  const openedGroup = {
    id: "group-opened",
    api: {
      setSize: (size: { height?: number; width?: number }) =>
        resizeCalls.push(size),
    },
    height: 200,
    width: 300,
  };

  const api = createDockApi({
    activeGroup,
    addPanel: (params) => {
      addedPanels.push(params);
      return { id: params.id, focus: () => {}, group: openedGroup };
    },
  });

  const leftResult = openOrFocusPanel(
    api,
    "panel-PatchLeft",
    "Patch",
    "Patch Left",
    "split-left",
  );
  const rightResult = openOrFocusPanel(
    api,
    "panel-PatchRight",
    "Patch",
    "Patch Right",
    "split-right",
  );

  assert.equal(leftResult, "opened");
  assert.equal(rightResult, "opened");
  assert.deepEqual(addedPanels[0]?.position, {
    direction: "left",
    referenceGroup: "group-active",
  });
  assert.deepEqual(addedPanels[1]?.position, {
    direction: "right",
    referenceGroup: "group-active",
  });
  assert.equal(addedPanels[0]?.initialHeight, undefined);
  assert.equal(addedPanels[0]?.initialWidth, 150);
  assert.equal(addedPanels[1]?.initialHeight, undefined);
  assert.equal(addedPanels[1]?.initialWidth, 150);
  assert.deepEqual(resizeCalls, [
    { width: 150 },
    { width: 150 },
    { width: 150 },
    { width: 150 },
  ]);
});

test("openOrFocusPanel skips when dock api is unavailable", () => {
  const result = openOrFocusPanel(
    undefined,
    "panel-CommandLine",
    "CommandLine",
    "Console",
  );

  assert.equal(result, "skipped");
});
