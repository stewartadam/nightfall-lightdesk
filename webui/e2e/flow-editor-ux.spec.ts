// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

test.use({ experimentalFlows: true });

const FLOW_UID = "67676767676767676767676767676767";
const FLOW_PANEL_ID = `flow-editor-${FLOW_UID}`;

type TestFlowNode = {
  id: number;
  kind: string;
  label: string;
  x: number;
  y: number;
};

type TestFlowEdge = {
  fromNodeId: number;
  fromPortId: number;
  toNodeId: number;
  toPortId: number;
};

/** Creates a minimal flow definition that the Flow Editor can render. */
function buildFlow(nodes: TestFlowNode[], edges: TestFlowEdge[] = []) {
  return {
    identifiers: {
      id: 901,
      uid: FLOW_UID,
      label: "Flow Editor UX",
    },
    flow_version: 1,
    nodes: nodes.map((node) => ({
      node_id: node.id,
      kind: node.kind,
      label: node.label,
      ports: [
        {
          port_id: 1,
          name: "Input",
          direction: "input",
          port_type: "number",
        },
        {
          port_id: 2,
          name: "Value",
          direction: "output",
          port_type: "number",
        },
      ],
      position: { x: node.x, y: node.y },
    })),
    edges: edges.map((edge) => ({
      from: { node_id: edge.fromNodeId, port_id: edge.fromPortId },
      to: { node_id: edge.toNodeId, port_id: edge.toPortId },
    })),
  };
}

/** Waits until the app shell and DockView API are ready for direct panel setup. */
async function openApp(page: Page) {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");
  await prepareStoreSeededTestApp(page);
}

/** Seeds a test flow and bumps the definition revision used by flow editor panels. */
async function seedFlow(
  page: Page,
  nodes: TestFlowNode[],
  edges: TestFlowEdge[] = [],
) {
  const flow = buildFlow(nodes, edges);
  await page.evaluate((seededFlow) => {
    const stores = (window as any).appStores;
    stores.flows.set({ [seededFlow.identifiers.uid]: seededFlow });
    stores.flowDefinitionsRevision.set(
      stores.flowDefinitionsRevision.get() + 1,
    );
  }, flow);
}

/** Opens the seeded flow editor in a controlled DockView panel. */
async function openSeededFlowEditor(page: Page) {
  await page.evaluate(
    ({ flowPanelId, flowUid }) => {
      const stores = (window as any).appStores;
      const api = stores.dockApi.get();
      const existing = api.getPanel(flowPanelId);
      if (existing) {
        existing.api.setActive();
        existing.focus();
        return;
      }
      const panel = api.addPanel({
        id: flowPanelId,
        component: "FlowEditor",
        title: "Flow 901: Flow Editor UX",
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: { initialFlowUid: flowUid },
        renderer: "onlyWhenVisible",
      });
      panel.api.setActive();
      panel.focus();
    },
    { flowPanelId: FLOW_PANEL_ID, flowUid: FLOW_UID },
  );
  await expect(page.locator(".solid-flow:visible")).toHaveCount(1);
}

/** Verifies loaded flow snapshots replace the rendered graph in an open editor. */
test("flow editor rerenders when loaded flow definitions replace store data", async ({
  page,
}) => {
  await openApp(page);
  await seedFlow(page, [
    { id: 1, kind: "Source", label: "Initial Node", x: 80, y: 60 },
  ]);
  await openSeededFlowEditor(page);

  const graph = page.locator(".solid-flow:visible").first();
  await expect(graph.getByText("Initial Node")).toBeVisible();

  await seedFlow(page, [
    { id: 1, kind: "Source", label: "Loaded Source", x: 80, y: 60 },
    { id: 2, kind: "Scale", label: "Loaded Scale", x: 340, y: 60 },
  ]);

  await expect(graph.getByText("Initial Node")).toHaveCount(0);
  await expect(graph.getByText("Loaded Source")).toBeVisible();
  await expect(graph.getByText("Loaded Scale")).toBeVisible();
});

/** Verifies right-click insertion does not rebuild from stale deleted nodes. */
test("right-click insertion keeps linked deleted nodes removed", async ({
  page,
}, testInfo) => {
  await openApp(page);
  await seedFlow(
    page,
    [
      { id: 1, kind: "Source", label: "Source", x: 80, y: 60 },
      { id: 2, kind: "Scale", label: "Deleted Node", x: 340, y: 60 },
    ],
    [{ fromNodeId: 1, fromPortId: 2, toNodeId: 2, toPortId: 1 }],
  );
  await openSeededFlowEditor(page);

  const graph = page.locator(".solid-flow:visible").first();
  await expect(graph.locator(".solid-flow__edge")).toHaveCount(1);

  const deletedNode = graph
    .locator(".solid-flow__node")
    .filter({ hasText: "Deleted Node" });
  const deleteButton = page.getByRole("button", {
    name: "Delete",
    exact: true,
  });
  await expect(async () => {
    await deletedNode.getByText("Deleted Node", { exact: true }).click();
    await expect(deleteButton).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 8_000 });
  await expect(deleteButton).toHaveClass(/nf-button/);
  await page.locator(".solid-flow__node-toolbar:visible").screenshot({
    path: testInfo.outputPath("shared-flow-node-actions.png"),
  });
  await deleteButton.click();
  await expect(graph.getByText("Deleted Node")).toHaveCount(0);
  await expect(graph.locator(".solid-flow__edge")).toHaveCount(0);

  const pane = graph.locator(".solid-flow__pane").first();
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  await pane.dispatchEvent("contextmenu", {
    button: 2,
    buttons: 2,
    clientX: paneBox!.x + paneBox!.width * 0.8,
    clientY: paneBox!.y + paneBox!.height * 0.8,
  });
  const addSource = page.getByRole("button", { name: "Source", exact: true });
  await expect(addSource).toHaveClass(/nf-menu-item/);
  const addMenu = graph.locator(".nf-menu").filter({ hasText: "Add Node" });
  const menuBox = await addMenu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(paneBox!.x);
  expect(menuBox!.y).toBeGreaterThanOrEqual(paneBox!.y);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(
    paneBox!.x + paneBox!.width,
  );
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(
    paneBox!.y + paneBox!.height,
  );
  await addMenu.screenshot({
    path: testInfo.outputPath("shared-flow-add-menu.png"),
  });
  await addSource.scrollIntoViewIfNeeded();
  await expect(addSource).toBeInViewport();
  await addSource.click();

  await expect(graph.getByText("Deleted Node")).toHaveCount(0);
  await expect(graph.locator(".solid-flow__node")).toHaveCount(2);
});

/** Verifies inactive flow editor tabs do not leave graph items over focused panels. */
test("inactive flow editor tab hides graph overlay content", async ({
  page,
}) => {
  await openApp(page);
  await seedFlow(page, [
    { id: 1, kind: "Source", label: "Overlay Source", x: 80, y: 60 },
  ]);
  await openSeededFlowEditor(page);

  await expect(page.locator(".solid-flow__node:visible")).toHaveCount(1);

  await page.evaluate((flowPanelId) => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: "flow-editor-overlay-target",
      component: "StatusDisplay",
      title: "Status Overlay Target",
      position: { referencePanel: flowPanelId, direction: "within" },
    });
    api.getPanel("flow-editor-overlay-target")?.focus();
  }, FLOW_PANEL_ID);

  await expect(page.locator(".solid-flow__node:visible")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Active Instances" }),
  ).toBeVisible();
});

/** Exercises the shared numeric field inside a graph node without dragging or losing its fractional draft. */
test("flow inline number editor retains fractional edits and graph position", async ({
  page,
}, testInfo) => {
  await openApp(page);
  await seedFlow(page, [
    { id: 1, kind: "Scale", label: "Editable scale", x: 80, y: 60 },
  ]);
  await openSeededFlowEditor(page);
  const node = page
    .locator(".solid-flow__node")
    .filter({ hasText: "Editable scale" });
  const field = node.getByRole("spinbutton");
  await expect(field).toHaveClass(/nf-form-control/);
  const position = await node.getAttribute("style");
  await field.fill("1.25");
  await field.blur();
  await expect(field).toHaveValue("1.25");
  await expect(node).toHaveAttribute("style", position!);
  await node.screenshot({
    path: testInfo.outputPath("shared-flow-number.png"),
  });
});
