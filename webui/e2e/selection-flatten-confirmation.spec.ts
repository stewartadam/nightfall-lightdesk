// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

test.describe.configure({ mode: "serial" });

/** Waits for the interactive shell to finish mounting confirmation UI. */
async function waitForConfirmationUi(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.requestSelectionFlattenConfirmation ===
      "function",
  );
  await page.waitForTimeout(3_000);
}

/** Verifies confirmation presents the retry and resubmits it as a fresh command. */
test("selection flatten confirmation resubmits an explicitly approved command", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForConfirmationUi(page);

  await page.evaluate(() => {
    (window as any).appStores.requestSelectionFlattenConfirmation(
      {
        module: "UserCommand",
        command: {
          type: "Clear",
          data: {
            targets: [],
            allow_selection_flatten: true,
            selection_flatten_approval: crypto.randomUUID(),
          },
        },
      },
      crypto.randomUUID(),
    );
  });

  const confirmation = page.getByRole("dialog", {
    name: "Confirm Selection Flatten",
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(
    "This command may flatten programmer selection expressions",
  );

  await confirmation.getByRole("button", { name: "Continue" }).click();

  await expect(confirmation).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.selectionFlattenConfirmation.get() === null,
      ),
    )
    .toBe(true);
});

/** Verifies canceling a detached confirmation preserves the backend rejection in scrollback. */
test("canceling selection flatten confirmation settles pending console status", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForConfirmationUi(page);

  const correlationId = await page.evaluate(() => {
    const id = crypto.randomUUID();
    (window as any).appStores.consoleScrollback.set([
      {
        id,
        correlationId: id.replaceAll("-", ""),
        command: "clear selection fix 1",
        source: "OSC",
        submittedAt: Date.now(),
        status: "pending",
      },
    ]);
    (window as any).appStores.requestSelectionFlattenConfirmation(
      {
        module: "UserCommand",
        command: {
          type: "Clear",
          data: {
            targets: [],
            allow_selection_flatten: true,
            selection_flatten_approval: crypto.randomUUID(),
          },
        },
      },
      id,
      {
        type: "Failed",
        data: {
          code: "programmer.selection_flatten_confirmation_required",
          message: "Selection flatten confirmation required",
          details: null,
        },
      },
    );
    return id;
  });

  const confirmation = page.getByRole("dialog", {
    name: "Confirm Selection Flatten",
  });
  await confirmation.getByRole("button", { name: "Cancel" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).appStores.consoleScrollback
            .get()
            .find((entry: any) => entry.id === id)?.status,
        correlationId,
      ),
    )
    .toBe("error");
});

/** Verifies an awaited prompt settles the fire-and-forget prompt it displaces. */
test("awaited confirmation settles a displaced resubmit failure", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForConfirmationUi(page);

  const correlationId = await page.evaluate(() => {
    const id = crypto.randomUUID();
    const retry = {
      module: "UserCommand" as const,
      command: {
        type: "Clear",
        data: {
          targets: [],
          allow_selection_flatten: true,
          selection_flatten_approval: crypto.randomUUID(),
        },
      },
    };
    (window as any).appStores.consoleScrollback.set([
      {
        id,
        correlationId: id.replaceAll("-", ""),
        command: "clear selection fix 1",
        source: "OSC",
        submittedAt: Date.now(),
        status: "pending",
      },
    ]);
    (window as any).appStores.requestSelectionFlattenConfirmation(retry, id, {
      type: "Failed",
      data: {
        code: "programmer.selection_flatten_confirmation_required",
        message: "Selection flatten confirmation required",
        details: null,
      },
    });
    void (window as any).appStores.waitForSelectionFlattenConfirmation(retry);
    return id;
  });

  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).appStores.consoleScrollback
            .get()
            .find((entry: any) => entry.id === id)?.status,
        correlationId,
      ),
    )
    .toBe("error");

  await page
    .getByRole("dialog", { name: "Confirm Selection Flatten" })
    .getByRole("button", { name: "Cancel" })
    .click();
});
