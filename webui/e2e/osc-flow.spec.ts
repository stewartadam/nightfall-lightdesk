// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/**
 * Opens the application with a clean layout and a viewport large enough for
 * the OSC and CommandLine panels to render without truncating their controls.
 */
async function openOscFlowApp(page: Page, backendPort: number) {
  await prepareFreshBackendShowfile(backendPort);
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
}

/**
 * Waits for the Dockview API and dev test stores to be available in the page.
 */
async function waitForAppStores(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();

      /** Polls browser state until the awaited test condition is satisfied. */
      const tick = () => {
        const stores = (window as any).appStores;
        if (stores?.dockApi?.get?.() && stores.oscLastEvent) {
          resolve();
          return;
        }
        if (Date.now() - started > 15_000) {
          reject(new Error("app stores did not initialize"));
          return;
        }
        window.setTimeout(tick, 100);
      };
      tick();
    });
  });
}

/**
 * Adds and activates a dock panel using the same registry path the command
 * palette uses, while keeping the test independent of palette rendering.
 */
async function addPanel(
  page: Page,
  panel: {
    id: string;
    component: string;
    title: string;
    position?: Record<string, unknown>;
  },
) {
  await waitForAppStores(page);
  await page.evaluate((panel) => {
    const api = (window as any).appStores.dockApi.get();
    const referencePanel =
      (api.activePanel?.api.location.type === "grid"
        ? api.activePanel
        : undefined) ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
    const existingPanel = api.getPanel(panel.id);
    if (existingPanel) {
      existingPanel.api.close();
    }
    const nextPanel = api.addPanel({
      id: panel.id,
      component: panel.component,
      title: panel.title,
      params: {},
      ...(panel.position
        ? { position: panel.position }
        : referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
    });
    nextPanel.api.setActive();
    nextPanel.focus();
  }, panel);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe(panel.id);
}

/**
 * Captures submitted command payloads while keeping the worker message
 * handler available for backend-like messages injected by this spec.
 */
async function captureWebsocketSends(page: Page) {
  await page.evaluate(async () => {
    const { engineRuntime } = window.__nightfallTest.runtime;
    const worker = engineRuntime.worker;
    if (!worker) {
      throw new Error("websocket worker did not initialize");
    }
    const sentMessages: unknown[] = [];
    (window as any).__oscFlowSentMessages = sentMessages;
    worker.postMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "submit"
      ) {
        sentMessages.push((message as { data?: unknown }).data);
      }
    };
  });
}

/**
 * Seeds the OSC listener stores as if the backend had received an OSC packet.
 */
async function seedOscLastEvent(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.oscListenerStatus.set({
      is_listening: true,
      bind_address: "127.0.0.1",
      port: 9000,
    });
    stores.oscSources.set([{ address: "127.0.0.1:9100" }]);
    stores.oscLastEvent.set({
      source: "127.0.0.1:9100",
      address: "/e2e/osc/go",
      args: [{ type: "Float", data: 0.75 }],
    });
  });
}

/**
 * Returns the latest UpsertMapping command captured from the OSC panel.
 */
async function latestUpsertMappingCommand(page: Page) {
  return page.evaluate(() => {
    const messages = ((window as any).__oscFlowSentMessages ?? []) as Array<{
      module?: string;
      command?: { type?: string; data?: unknown };
    }>;
    return messages
      .filter(
        (message) =>
          message.module === "OscCommand" &&
          message.command?.type === "UpsertMapping",
      )
      .at(-1)?.command;
  });
}

/**
 * Injects the websocket message emitted when an OSC Eval mapping dispatches a
 * command, so the CommandLine panel exercises the real websocket handler.
 */
async function dispatchOscExternalEval(page: Page) {
  await page.evaluate(async () => {
    const { engineRuntime } = window.__nightfallTest.runtime;
    const worker = engineRuntime.worker;
    if (!worker?.onmessage) {
      throw new Error("websocket worker message handler did not initialize");
    }
    worker.onmessage({
      data: {
        type: "message",
        postedAtMs: performance.timeOrigin + performance.now(),
        data: {
          type: "OscExternalEval",
          data: {
            correlation_id: "12345678-1234-4234-9234-123456789abc",
            command: "clip 1 go",
            source: "OSC 127.0.0.1:9100",
          },
        },
      },
    } as MessageEvent);
  });
}

/**
 * Validates the OSC operator flow from a received packet through mapping
 * creation and the CommandLine source tag shown for an OSC-dispatched command.
 */
test("OSC event can create a mapping and render dispatched command source", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOscFlowApp(page, backendSlot.backendPort);
  await waitForAppStores(page);
  await captureWebsocketSends(page);
  await seedOscLastEvent(page);

  await addPanel(page, {
    id: "panel-OscInput-flow-e2e",
    component: "OscInput",
    title: "OSC Input",
  });
  await expect(page.getByText("OSC Listener", { exact: true })).toBeVisible();
  await expect(page.getByText("/e2e/osc/go")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Mapping" }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Action for last input" })
    .selectOption("programmer.clear");
  await page.getByRole("button", { name: "Add Mapping" }).click();

  await expect
    .poll(() => latestUpsertMappingCommand(page))
    .toMatchObject({
      type: "UpsertMapping",
      data: {
        address: "/e2e/osc/go",
        arg_index: 0,
        action: { id: "programmer.clear", arguments: {} },
      },
    });

  const upsertMappingCommand = await latestUpsertMappingCommand(page);
  expect(upsertMappingCommand).toMatchObject({
    type: "UpsertMapping",
    data: {
      address: "/e2e/osc/go",
      arg_index: 0,
      action: { id: "programmer.clear", arguments: {} },
    },
  });

  await page.evaluate((command) => {
    if (!command) {
      throw new Error("expected UpsertMapping command");
    }
    const stores = (window as any).appStores;
    stores.oscMappings.set([command.data]);
  }, upsertMappingCommand);
  await expect(
    page
      .getByText("Clear programmer", { exact: true })
      .locator("visible=true")
      .first(),
  ).toBeVisible();

  await addPanel(page, {
    id: "panel-CommandLine-osc-flow-e2e",
    component: "CommandLine",
    title: "CommandLine",
    position: {
      referencePanel: "panel-OscInput-flow-e2e",
      direction: "right",
    },
  });
  await dispatchOscExternalEval(page);

  const commandRow = page.locator("div", { hasText: "clip 1 go" }).last();
  await expect(commandRow).toBeVisible();
  await expect(commandRow.getByText("OSC 127.0.0.1:9100")).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath("osc-flow-command-source.png"),
    fullPage: true,
  });
});
