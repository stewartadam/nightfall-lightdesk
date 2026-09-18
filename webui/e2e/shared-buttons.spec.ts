// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Locator,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads visible toolbar geometry and selection styling independently of its command handlers. */
async function buttonAppearance(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      width: style.width,
      height: style.height,
      color: style.color,
      background: style.backgroundColor,
      shadow: style.boxShadow,
    };
  });
}

/** Checks pointer feedback and shared editor toggle presentation while exercising real preview actions. */
test("editor toolbars share the lab button states", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/design-lab.html");
  const index = page.getByRole("navigation", { name: "Component index" });
  await index.getByRole("button", { name: /Buttons/ }).click();
  const buttons = page.getByRole("region", { name: "Button examples" });
  const apply = buttons.getByRole("button", { name: "Apply", exact: true });
  await apply.hover();
  await page.mouse.down();
  await expect(apply).toHaveCSS("filter", "brightness(0.82)");
  await page.mouse.up();
  await expect(buttons.getByRole("status")).toHaveText(
    "Sample changes applied.",
  );
  await expect(
    buttons.getByRole("button", { name: "Unavailable" }),
  ).toBeDisabled();
  await index.getByRole("button", { name: /Toolbars/ }).click();
  const list = page.getByRole("button", { name: "List view", exact: true });
  await list.click();
  await page.mouse.move(0, 0);
  const selected = await buttonAppearance(list);

  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const sequence = Object.values(stores.sequences.get())[0] as any;
    stores.dockApi.get().addPanel({
      id: "shared-buttons-sequence",
      component: "SequenceEditor",
      title: "Sequence button check",
      params: {
        initialPanelId: "shared-buttons-sequence",
        initialSequenceUid: sequence.identifiers.uid,
      },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
  });
  const sequenceToolbar = page.locator(
    '[data-sequence-editor-toolbar="true"]:visible',
  );
  const transitions = sequenceToolbar.getByRole("button", {
    name: "Toggle preview transitions",
    exact: true,
  });
  await expect(transitions).toBeDisabled();
  await expect(transitions.locator("svg")).toHaveCount(1);
  await sequenceToolbar
    .getByRole("button", { name: "Start preview", exact: true })
    .click();
  try {
    const stop = sequenceToolbar.getByRole("button", {
      name: "Stop preview",
      exact: true,
    });
    await expect(stop).toHaveAttribute("aria-pressed", "true");
    await expect(transitions).toBeEnabled();
    await page.mouse.move(0, 0);
    expect(await buttonAppearance(stop)).toEqual(selected);
    const previous = await transitions.getAttribute("aria-pressed");
    await transitions.click();
    await expect(transitions).toHaveAttribute(
      "aria-pressed",
      previous === "true" ? "false" : "true",
    );
    await page.screenshot({
      path: testInfo.outputPath("shared-sequence-toolbar.png"),
    });
  } finally {
    await sequenceToolbar
      .getByRole("button", { name: "Stop preview", exact: true })
      .click();
  }

  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const cue = Object.values(stores.cues.get())[0] as any;
    stores.dockApi.get().addPanel({
      id: "shared-buttons-cue",
      component: "CueEditor",
      title: "Cue button check",
      params: {
        initialPanelId: "shared-buttons-cue",
        initialCueUid: cue.identifiers.uid,
      },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
  });
  const cueToolbar = page.locator('[data-cue-editor-toolbar="true"]:visible');
  const timings = cueToolbar.getByRole("button", {
    name: "Switch to timings display mode",
  });
  await timings.click();
  await expect(timings).toHaveAttribute("aria-pressed", "true");
  const preview = cueToolbar.getByRole("button", {
    name: "Toggle cue preview",
    exact: true,
  });
  await preview.click();
  try {
    await expect(preview).toHaveAttribute("aria-pressed", "true");
    await page.mouse.move(0, 0);
    expect(await buttonAppearance(preview)).toEqual(selected);
    await page.screenshot({
      path: testInfo.outputPath("shared-cue-toolbar.png"),
    });
    await page.setViewportSize({ width: 900, height: 700 });
    expect(
      await cueToolbar.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await expect(preview).toBeInViewport();
  } finally {
    if ((await preview.getAttribute("aria-pressed")) === "true")
      await preview.click();
  }
});
