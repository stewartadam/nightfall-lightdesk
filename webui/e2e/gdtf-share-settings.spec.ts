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

/** Opens Settings and returns the dialog. */
async function openSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
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
  const dialog = await openSettings(page);
  await dialog.getByRole("tab", { name: "Accounts", exact: true }).click();
  const section = dialog.getByRole("region", { name: "GDTF Share" });
  await expect(section).toBeVisible();
  const user = section.getByTestId("gdtf-share-user");
  const password = section.getByTestId("gdtf-share-password");
  const signIn = section.getByTestId("gdtf-share-sign-in");
  await expect(user).toBeEditable();
  await expect(signIn).toBeDisabled();
  // The note depends on whether the machine running the test has a system keychain.
  await expect(
    section.getByText(
      /saved in this computer's keychain|keychain isn't available/,
    ),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("01-signed-out.png") });

  await user.fill("lighting@example.com");
  await password.fill("wrong");
  const reveal = section.getByRole("button", { name: "Show password" });
  await expect(password).toHaveAttribute("type", "password");
  await reveal.click();
  await expect(reveal).toHaveAttribute("aria-pressed", "true");
  await expect(password).toHaveAttribute("type", "text");
  await page.screenshot({
    path: testInfo.outputPath("01b-password-shown.png"),
  });
  await reveal.click();
  await expect(password).toHaveAttribute("type", "password");
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
    section.getByText("Your account is saved in this computer's keychain."),
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

/**
 * The browser demo has no engine-side GDTF Share, so Settings leaves out the Accounts tab
 * and the section, even from a search.
 */
frontendOnlyTest(
  "browser demo hides GDTF Share settings",
  async ({ page }, testInfo) => {
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await waitForDockviewApp(page);
    const dialog = await openSettings(page);
    await expect(
      dialog.getByRole("tab", { name: "Network", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("tab", { name: "Accounts", exact: true }),
    ).toHaveCount(0);
    await dialog.getByTestId("settings-search").locator("input").fill("GDTF");
    await expect(
      dialog.getByRole("region", { name: "GDTF Share" }),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("demo-settings.png") });
  },
);
