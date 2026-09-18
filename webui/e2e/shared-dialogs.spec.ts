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

/** Reads dialog presentation independently of the caller's width and content. */
async function presentation(dialog: Locator) {
  return dialog.evaluate((root) => {
    const element = root.matches(".nf-dialog-surface")
      ? root
      : root.querySelector(".nf-dialog-surface")!;
    const style = getComputedStyle(element);
    const header = getComputedStyle(
      element.querySelector(".nf-dialog-header")!,
    );
    const footer = getComputedStyle(
      element.querySelector(".nf-dialog-footer")!,
    );
    return {
      background: style.backgroundColor,
      border: style.border,
      radius: style.borderRadius,
      headerPadding: header.padding,
      footerPadding: footer.padding,
    };
  });
}

/** Compares real lab and programmer dialogs, then checks a tall object form on a narrow viewport. */
test("shared dialog presentation covers lab, store and creation forms", async ({
  page,
}, testInfo) => {
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Popups/ })
    .click();
  await page.getByRole("button", { name: "Open editor dialog" }).click();
  const editor = page.getByRole("dialog", {
    name: "Edit sample group",
    exact: true,
  });
  await expect(editor.getByLabel("Label", { exact: true })).toBeFocused();
  const style = await presentation(editor);
  await editor
    .getByLabel("Label", { exact: true })
    .fill("Shared dialog sample");
  await editor.getByRole("button", { name: "Save sample" }).click();
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "Open confirmation" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Delete sample group?",
    exact: true,
  });
  expect(await presentation(confirmation)).toEqual(style);
  await confirmation.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-confirmation.png"),
  });
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();

  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-Programmer")?.api.setActive();
    api.setEdgeGroupVisible("left", true);
    api.getEdgeGroup("left")?.expand();
  });
  for (const target of ["cue", "group"]) {
    await page
      .getByRole("button", { name: `Store ${target}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: target === "cue" ? "Store Cue" : "Store Group",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    expect(await presentation(dialog)).toEqual(style);
    await dialog.screenshot({
      path: testInfo.outputPath(`shared-store-${target}.png`),
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await page.evaluate(() => {
    (window as any).appStores.dockApi.get().addPanel({
      id: "shared-dialogs-objects",
      component: "ObjectLibrary",
      title: "Object Library",
      params: {},
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
  });
  await page
    .getByRole("button", { name: "Create object", exact: true })
    .click();
  const objectDialog = page.getByRole("dialog", {
    name: "Create Object",
    exact: true,
  });
  expect(await presentation(objectDialog)).toEqual(style);
  await page.setViewportSize({ width: 390, height: 700 });
  await objectDialog
    .getByRole("button", { name: "Create Object", exact: true })
    .click();
  await expect(
    objectDialog.getByText("Please select a GLB file", { exact: true }),
  ).toBeVisible();
  const bounds = await objectDialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.height).toBeLessThanOrEqual(668);
  await expect(
    objectDialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeInViewport();
  await expect(
    objectDialog.getByRole("heading", { name: "Create Object" }),
  ).toBeInViewport();
  await page.mouse.move(0, 0);
  await objectDialog.screenshot({
    path: testInfo.outputPath("shared-object-dialog-narrow.png"),
  });
  await objectDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(objectDialog).toBeHidden();
});
