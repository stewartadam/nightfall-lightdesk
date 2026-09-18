// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Checks stable header controls as edge rails appear, expand, hide, and disappear. */
test("header alignment stays fixed across edge rail states", async ({
  page,
}, testInfo) => {
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const header = page.locator(".nf-app-header");
  /** Measures viewport anchoring and control positions independently of the workspace. */
  const measureHeader = () =>
    header.evaluate((element) => {
      const nav = element.querySelector("nav")!.getBoundingClientRect();
      const command = element
        .querySelector(".nf-header-command-group")!
        .getBoundingClientRect();
      const brand = element
        .querySelector('img[alt="logo"]')!
        .parentElement!.getBoundingClientRect();
      const actions = element
        .querySelector('[aria-label="Open command palette"]')!
        .parentElement!.getBoundingClientRect();
      return {
        leftInset: nav.left,
        rightInset: window.innerWidth - nav.right,
        commandLeft: command.left,
        brandCenter: brand.left + brand.width / 2,
        viewportCenter: window.innerWidth / 2,
        actionsLeft: actions.left,
        actionsRight: actions.right,
      };
    });
  const initial = await measureHeader();
  expect(initial.leftInset).toBe(16);
  expect(initial.rightInset).toBe(16);
  expect(initial.commandLeft).toBe(16);
  expect(Math.abs(initial.brandCenter - initial.viewportCenter)).toBeLessThan(
    1,
  );

  for (const [left, right] of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
    [true, true],
  ]) {
    await page.evaluate(
      ({ left, right }) => {
        const api = (window as any).appStores.dockApi.get();
        for (const [edge, visible] of [
          ["left", left],
          ["right", right],
        ]) {
          api.setEdgeGroupVisible(edge, visible);
          api.getEdgeGroup(edge).collapse();
        }
      },
      { left, right },
    );
    await expect(header).toHaveCSS("padding-left", "16px");
    await expect(header).toHaveCSS("padding-right", "16px");
    await expect.poll(measureHeader).toEqual(initial);
    await page.screenshot({
      path: testInfo.outputPath(`header-rails-${left}-${right}.png`),
    });
  }

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getEdgeGroup("left").expand();
    api.getEdgeGroup("right").expand();
  });
  await expect.poll(measureHeader).toEqual(initial);
  await page.screenshot({
    path: testInfo.outputPath("header-expanded-rails.png"),
  });

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.removeEdgeGroup("left");
    api.removeEdgeGroup("right");
  });
  await expect(header).toHaveCSS("padding-left", "16px");
  await expect(header).toHaveCSS("padding-right", "16px");
  await expect.poll(measureHeader).toEqual(initial);
  await page.screenshot({
    path: testInfo.outputPath("header-no-edge-groups.png"),
  });
});

for (const { platform, modifier, label } of [
  { platform: "MacIntel", modifier: "Meta", label: "⌘" },
  { platform: "Win32", modifier: "Control", label: "Ctrl" },
  { platform: "Linux x86_64", modifier: "Control", label: "Ctrl" },
]) {
  /** Verifies the advertised shortcut matches keyboard resolution for the emulated platform. */
  test(`header command hint resolves the modifier on ${platform}`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((platform) => {
      Object.defineProperty(navigator, "platform", { get: () => platform });
    }, platform);
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await waitForDockviewApp(page);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const logo = document.querySelector<HTMLImageElement>(
            '.nf-app-header img[alt="logo"]',
          )!;
          const brand = logo.parentElement!.getBoundingClientRect();
          return Math.abs(brand.left + brand.width / 2 - window.innerWidth / 2);
        }),
      )
      .toBeLessThan(1);
    const input = page.getByRole("textbox", {
      name: "Command input",
      exact: true,
    });
    await expect(input).toHaveAttribute(
      "placeholder",
      `${label}+L to enter command`,
    );
    await page
      .getByRole("navigation", { name: "Global" })
      .screenshot({ path: testInfo.outputPath("command-shortcut-hint.png") });
    await page.screenshot({ path: testInfo.outputPath("centered-header.png") });
    await page.keyboard.press(`${modifier}+l`);
    await expect(input).toBeFocused();
    await input.fill("fixture 1");
    await page
      .getByRole("navigation", { name: "Global" })
      .getByRole("img", { name: "logo" })
      .click();
    await page.keyboard.press(`${modifier}+l`);
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((element: HTMLInputElement) => ({
        start: element.selectionStart,
        end: element.selectionEnd,
      })),
    ).toEqual({ start: 0, end: "fixture 1".length });
  });
}
