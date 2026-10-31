// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { gridCellByKey } from "./data-grid-selectors";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const SEQUENCE_ID = 971;
const SEQUENCE_UID = "c9710000000000000000000000000001";
const SETUP_CUE_UID = "c9710000000000000000000000000002";
const RELEASE_CUE_UID = "c9710000000000000000000000000003";
const CUE_ONE_UID = "c9710000000000000000000000000011";
const CUE_TWO_UID = "c9710000000000000000000000000012";
const PANEL_ID = "panel-SequenceEditor-beat-timing-e2e";

test.describe.configure({ timeout: 120_000 });

/** Sends one engine command and fails the test unless it succeeds. */
async function sendCommand(page: Page, data: object): Promise<void> {
  const result = await page.evaluate(async (message) => {
    const stores = (window as any).appStores;
    return stores.sendAndAwait(message);
  }, data);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Builds an empty cue with the given trigger. */
function cue(id: number, uid: string, label: string, trigger: object): object {
  return {
    identifiers: { id, uid, label },
    trigger,
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds a two-cue chase whose second cue follows the first after 2 time units. */
function sequence(): object {
  const zero = { type: "Fixed", data: { secs: 0, nanos: 0 } };
  return {
    identifiers: { id: SEQUENCE_ID, uid: SEQUENCE_UID, label: "Beat Chase" },
    steps: [CUE_ONE_UID, CUE_TWO_UID],
    wrap: false,
    release_on_start: false,
    setup_cue: cue(0, SETUP_CUE_UID, "Setup", { type: "Manual" }),
    release_cue: cue(0, RELEASE_CUE_UID, "Release", { type: "Manual" }),
    default_timing: {
      delay_in: zero,
      fade_in: zero,
      curve_in: "Linear",
      delay_out: zero,
      fade_out: zero,
      curve_out: "Linear",
    },
    tracking_mode: { type: "Inherit" },
  };
}

/** Stores the chase on a fresh backend show and opens it in a Sequence Editor with Properties. */
async function openBeatChase(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () => typeof (window as any).appStores?.sendAndAwait === "function",
  );

  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "StoreCue",
      data: cue(1, CUE_ONE_UID, "Left", { type: "Manual" }),
    },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "StoreCue",
      data: cue(2, CUE_TWO_UID, "Right", {
        type: "AfterDelay",
        data: { secs: 2, nanos: 0 },
      }),
    },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: sequence() },
  });

  await page.evaluate(
    ({ panelId, sequenceUid }) => {
      const api = (window as any).appStores.dockApi.get();
      const referencePanel =
        api.getPanel("panel-Groups") ??
        api.panels.find(
          (candidate: any) => candidate.api.location.type === "grid",
        );
      const panel = api.addPanel({
        id: panelId,
        component: "SequenceEditor",
        title: "Beat Chase",
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
        params: { initialPanelId: panelId, initialSequenceUid: sequenceUid },
      });
      if (!api.getPanel("panel-PropertiesInspector")) {
        api.addPanel({
          id: "panel-PropertiesInspector",
          component: "PropertiesInspector",
          title: "Properties",
          params: {},
        });
      }
      panel.api.setActive();
      panel.focus();
    },
    { panelId: PANEL_ID, sequenceUid: SEQUENCE_UID },
  );
}

/** Verifies switching a sequence to Beats stores it and shows its trigger times in beats. */
test("sequence Timing switch counts trigger times in beats", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openBeatChase(page, backendSlot.backendPort);
  const grid = page
    .locator(`[data-component="SequenceEditor"][data-panel-id="${PANEL_ID}"]`)
    .locator('[data-grid-owner="sequence-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  const cueTwoTime = gridCellByKey(grid, {
    columnKey: "after_delay",
    rowKey: `${CUE_TWO_UID}:cue`,
  });
  await expect(cueTwoTime).toContainText("2s");

  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  const timing = page.getByRole("radiogroup", { name: "Timing" });
  await expect(timing).toBeVisible();
  await timing.getByRole("radio", { name: "Beats" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.sequences.get()[uid]?.timebase,
        SEQUENCE_UID,
      ),
    )
    .toBe("Beats");
  await expect(cueTwoTime).toContainText("2b");
  await expect(page.getByText("Sequence Default Timing (beats)")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("sequence-timing-beats.png"),
  });

  await timing.getByRole("radio", { name: "Seconds" }).click();
  await expect(cueTwoTime).toContainText("2s");
});
