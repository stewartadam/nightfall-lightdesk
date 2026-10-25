// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  frontendOnlyTest,
  type Page,
  test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Opens Settings on its Network tab and returns the dialog. */
async function openNetworkSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Network", exact: true }).click();
  return dialog;
}

/**
 * Walks the GDTF Share sign-in states against the real backend's status and sign-out routes,
 * with sign-in answered by a stand-in so the test never contacts GDTF Share: the signed-out
 * form, a refused password, the signed-in account, then signing out again.
 */
test("signs in to GDTF Share from Settings and out again", async ({
  page,
}, testInfo) => {
  const signIns: unknown[] = [];
  await page.route("**/api/gdtf-share/account", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const body = route.request().postDataJSON();
      signIns.push(body);
      if (body.password !== "correct horse") {
        await route.fulfill({
          status: 422,
          body: "GDTF Share did not accept the username and password: No valid user or password provided.",
        });
        return;
      }
      await route.fulfill({
        json: {
          user: body.user,
          source: "keychain",
          keychain_available: true,
        },
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  const dialog = await openNetworkSettings(page);
  const section = dialog.getByRole("region", { name: "GDTF Share" });
  await expect(section).toBeVisible();
  const user = section.getByTestId("gdtf-share-user");
  const password = section.getByTestId("gdtf-share-password");
  const signIn = section.getByTestId("gdtf-share-sign-in");
  await expect(user).toBeEnabled();
  await expect(signIn).toBeDisabled();
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("01-signed-out.png") });

  await user.fill("lighting@example.com");
  await password.fill("wrong");
  await password.press("Enter");
  await expect(section.getByText("No valid user or password")).toBeVisible();
  await expect(password).toHaveValue("wrong");
  await page.screenshot({ path: testInfo.outputPath("02-refused.png") });

  await password.fill("correct horse");
  await signIn.click();
  const account = section.getByTestId("gdtf-share-account");
  await expect(
    account.getByText("Signed in as lighting@example.com"),
  ).toBeVisible();
  await expect(
    account.getByText("Saved in this computer's keychain."),
  ).toBeVisible();
  expect(signIns).toEqual([
    { user: "lighting@example.com", password: "wrong" },
    { user: "lighting@example.com", password: "correct horse" },
  ]);
  await page.screenshot({ path: testInfo.outputPath("03-signed-in.png") });

  await section.getByTestId("gdtf-share-sign-out").click();
  await expect(user).toBeVisible();
  await expect(password).toHaveValue("");
  await page.screenshot({ path: testInfo.outputPath("04-signed-out.png") });
});

/** The browser demo has no engine-side GDTF Share, so Settings leaves the section out. */
frontendOnlyTest(
  "browser demo hides GDTF Share settings",
  async ({ page }, testInfo) => {
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await waitForDockviewApp(page);
    const dialog = await openNetworkSettings(page);
    await expect(
      dialog.getByRole("heading", { name: "Network", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("region", { name: "GDTF Share" }),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("demo-network.png") });
  },
);
