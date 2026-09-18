// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { routeShowfileDiscovery } from "./showfile-startup";

type MockCommandResult =
  | { type: "Succeeded"; data: unknown }
  | {
      type: "Failed";
      data: { code: string; message: string; details: null };
    };

const defaultDraftFixture = {
  showfileName: "default",
  modifiedMs: 1_700_000_100_000,
  savedModifiedMs: 1_700_000_000_000,
  validationStatus: "unchecked" as const,
};

const tourDraftFixture = {
  showfileName: "tour",
  modifiedMs: 1_700_000_100_000,
  savedModifiedMs: 1_700_000_000_000,
  validationStatus: "unchecked" as const,
};

/**
 * Captures WebSocket worker sends so menu actions can be asserted without mutating backend state.
 */
async function captureWorkerSends(
  page: Page,
  options: {
    commandResults?: Record<string, MockCommandResult>;
    deferredCommands?: string[];
  } = {},
) {
  await page.addInitScript((options) => {
    const globalWindow = window as Window & {
      __nightfallWorkerSends?: unknown[];
    };
    globalWindow.__nightfallWorkerSends = [];
    const commandResults = options.commandResults ?? {};
    const deferredCommands = new Set(options.deferredCommands ?? []);
    const postWorkerMessage = (worker: Worker, message: unknown) => {
      worker.onmessage?.(
        new MessageEvent("message", {
          data: {
            type: "message",
            data: message,
            postedAtMs: performance.timeOrigin + performance.now(),
          },
        }),
      );
    };
    const swappedShowfileName = (command?: {
      type?: string;
      data?: unknown;
    }) => {
      switch (command?.type) {
        case "NewNamedShowfile":
        case "LoadNamedShowfile":
        case "LoadDraftShowfile":
          return typeof command.data === "string" ? command.data : "default";
        case "LoadShowfileRevision":
          return command.data &&
            typeof command.data === "object" &&
            "showfileName" in command.data &&
            typeof command.data.showfileName === "string"
            ? command.data.showfileName
            : "default";
        case "NewShowfile":
        case "LoadShowfile":
          return "default";
        default:
          return null;
      }
    };
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      transfer?: StructuredSerializeOptions | Transferable[],
    ) {
      const envelope = message as {
        type?: string;
        data?: {
          command_id?: unknown;
          correlation_id?: unknown;
          module?: string;
          command?: { type?: string; data?: unknown };
        };
      };
      if (envelope?.type === "submit") {
        globalWindow.__nightfallWorkerSends?.push(envelope.data);
        const blockedDeskCommands = new Set([
          "DiscardDraftShowfile",
          "Eval",
          "LoadDraftShowfile",
          "LoadNamedShowfile",
          "LoadShowfile",
          "LoadShowfileRevision",
          "NewNamedShowfile",
          "NewShowfile",
        ]);
        if (
          envelope.data?.module === "DeskCommand" &&
          blockedDeskCommands.has(envelope.data.command?.type ?? "")
        ) {
          if (deferredCommands.has(envelope.data.command?.type ?? "")) {
            return;
          }

          const correlationId =
            envelope.data.command_id ?? envelope.data.correlation_id;
          if (correlationId !== undefined && correlationId !== null) {
            const commandType = envelope.data.command?.type ?? "";
            const result = commandResults[commandType] ?? {
              type: "Succeeded",
              data: {},
            };
            window.setTimeout(() => {
              postWorkerMessage(this, {
                type: "CommandResult",
                data: {
                  command_id: correlationId,
                  outcome: result,
                },
              });
              const showfileName = swappedShowfileName(envelope.data?.command);
              if (result.type === "Succeeded" && showfileName) {
                postWorkerMessage(this, {
                  type: "UiNotification",
                  data: {
                    type: "CurrentShowfileChanged",
                    data:
                      showfileName === "default" ? {} : { name: showfileName },
                  },
                });
                postWorkerMessage(this, {
                  type: "AppState",
                  data: "Ready",
                });
                postWorkerMessage(this, {
                  type: "ResyncComplete",
                });
              }
              if (
                result.type === "Succeeded" &&
                commandType === "Eval" &&
                envelope.data?.command?.data === "load tour"
              ) {
                postWorkerMessage(this, {
                  type: "UiNotification",
                  data: {
                    type: "CurrentShowfileChanged",
                    data: { name: "tour" },
                  },
                });
                postWorkerMessage(this, {
                  type: "AppState",
                  data: "Ready",
                });
                postWorkerMessage(this, {
                  type: "ResyncComplete",
                });
              }
              if (
                result.type === "Succeeded" &&
                commandType === "Eval" &&
                envelope.data?.command?.data === "new show"
              ) {
                postWorkerMessage(this, {
                  type: "UiNotification",
                  data: {
                    type: "CurrentShowfileChanged",
                    data: { name: "command-new" },
                  },
                });
                postWorkerMessage(this, {
                  type: "AppState",
                  data: "Ready",
                });
                postWorkerMessage(this, {
                  type: "ResyncComplete",
                });
              }
            }, 0);
          }
          return;
        }
      }

      return originalPostMessage.call(this, message, transfer as never);
    } as Worker["postMessage"];
  }, options);
}

/** Answers the next app show-name prompt with the provided value. */
async function answerShowNamePrompt(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Show name").fill(name);
  await dialog.getByRole("button", { name: "Create Show" }).click();
}

/** Disables the global E2E startup auto-open storage state for picker tests. */
async function disableE2eStartupAutoOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall.e2eAutoOpenStartupShowfile",
      "false",
    );
  });
}

test("shows grouped showfile actions in the status bar menu", async ({
  page,
}) => {
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ showfiles: [] }),
    });
  });
  await page.goto("/?e2e=1");

  const menuButton = page.locator("button[title='Menu']");
  await expect(menuButton).toBeVisible();

  await menuButton.click();
  await expect(
    page.getByRole("button", { name: "New Showfile" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Showfile" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import Showfile" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save Showfile" }),
  ).toBeVisible();
  await expect(page.locator("hr")).toHaveCount(2);

  await page.getByRole("button", { name: "Import Showfile" }).click();
  const dialog = page.getByRole("dialog", { name: "Import Showfile" });
  await expect(dialog).toBeVisible();
  const showfilePathDropZone = dialog.getByLabel("Showfile Path");
  await expect(showfilePathDropZone).toBeVisible();
  await expect(showfilePathDropZone).toContainText(
    "Drop a .nightfall-show folder here or click to browse",
  );
  const fileChooserPromise = page.waitForEvent("filechooser");
  await showfilePathDropZone.click();
  const fileChooser = await fileChooserPromise;
  expect(fileChooser.isMultiple()).toBe(false);
  await expect(dialog.getByLabel("Timelines import policy")).toHaveValue(
    "Skip",
  );
  await expect(dialog.getByLabel("Cues import policy")).toHaveValue("Merge");
  await expect(dialog.getByLabel("FX Modules import policy")).toHaveValue(
    "Overwrite",
  );
  await expect(
    dialog.getByLabel("FX Modules import policy").locator("option"),
  ).toHaveText(["Skip", "Overwrite"]);
  await expect(
    dialog.getByLabel("Cues import policy").locator("option"),
  ).toHaveText(["Skip", "Merge", "Replace", "Overwrite"]);

  await dialog.getByLabel("Bulk import policy").selectOption("Replace");
  await dialog
    .getByRole("button", { name: "Apply to all applicable rows" })
    .click();
  await expect(dialog.getByLabel("Fixtures / Patch import policy")).toHaveValue(
    "Replace",
  );
  await expect(dialog.getByLabel("Cues import policy")).toHaveValue("Replace");
  await expect(dialog.getByLabel("Settings import policy")).toHaveValue("Skip");
  await expect(dialog.getByLabel("Bindings import policy")).toHaveValue(
    "Merge",
  );
  await expect(dialog.getByLabel("FX Modules import policy")).toHaveValue(
    "Overwrite",
  );

  await dialog.getByLabel("Bulk import policy").selectOption("Overwrite");
  await dialog
    .getByRole("button", { name: "Apply to all applicable rows" })
    .click();
  await expect(dialog.getByLabel("Settings import policy")).toHaveValue(
    "Overwrite",
  );
  await expect(dialog.getByLabel("Bindings import policy")).toHaveValue(
    "Overwrite",
  );
  await expect(dialog.getByLabel("FX Modules import policy")).toHaveValue(
    "Overwrite",
  );

  await dialog
    .getByRole("button", { name: "Close import showfile dialog" })
    .click();
  await expect(dialog).toBeHidden();
});

/** Verifies tab close handling delegates draft preservation to the backend. */
test("triggers draft preservation on pagehide without dirty tracking", async ({
  page,
}) => {
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ showfiles: [] }),
    });
  });
  await page.addInitScript(() => {
    const globalWindow = window as Window & {
      __nightfallBeaconUrls?: string[];
    };
    globalWindow.__nightfallBeaconUrls = [];
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: (url: string | URL) => {
        globalWindow.__nightfallBeaconUrls?.push(String(url));
        return true;
      },
    });
  });

  await page.goto("/?e2e=1");
  await expect(page.locator("button[title='Menu']")).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
  });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const urls = (window as Window & { __nightfallBeaconUrls?: string[] })
          .__nightfallBeaconUrls;
        return urls?.some((url) =>
          url.endsWith("/api/showfiles/current/draft"),
        );
      }),
    )
    .toBe(true);
});

/** Verifies disabling draft recovery still waits for a startup showfile selection. */
test("skips draft recovery and prompts for a startup showfile", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await routeShowfileDiscovery(
    page,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          showfiles: [
            {
              name: "default",
              path: "/tmp/default.nightfall-show",
              modified_ms: 1_700_000_000_000,
              draft: {
                showfile_name: "default",
                name: "default.nightfall-show",
                path: "/tmp/drafts/default.nightfall-show",
                modified_ms: 1_700_000_100_000,
                saved_modified_ms: 1_700_000_000_000,
              },
              revisions: [],
            },
          ],
        }),
      });
    },
    defaultDraftFixture,
  );

  await page.goto("/?e2e=1&startup:bypassBackendReadiness=1");

  await expect(page.getByTestId("startup-splash")).toHaveCount(0);
  await expect(
    page.getByRole("dialog", {
      name: "Resume your work on default?",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Open Showfile" }),
  ).toBeVisible();
  await expect(page.locator("button[title='Menu']")).toHaveCount(0);
});

/** Verifies startup prompts for a newer draft without loading it before acceptance. */
test("prompts to load a newer startup draft", async ({ page }) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await routeShowfileDiscovery(
    page,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          showfiles: [
            {
              name: "default",
              path: "/tmp/default.nightfall-show",
              modified_ms: 1_700_000_000_000,
              draft: {
                showfile_name: "default",
                name: "default.nightfall-show",
                path: "/tmp/drafts/default.nightfall-show",
                modified_ms: 1_700_000_100_000,
                saved_modified_ms: 1_700_000_000_000,
              },
              revisions: [],
            },
          ],
        }),
      });
    },
    defaultDraftFixture,
  );

  await page.goto(
    "/?startup:draftRecovery=true&e2e=1&startup:bypassBackendReadiness=1",
  );
  const dialog = page.getByRole("dialog", {
    name: "Resume your work on default?",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
  await expect(dialog.getByText(/^Draft saved /)).toBeVisible();
  await expect(dialog.getByText(/^Saved snapshot /)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("shared-startup-recovery.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog.getByRole("button", { name: "Load Draft" }),
  ).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath("shared-startup-recovery-narrow.png"),
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  const draftLoadCount = async () =>
    page.evaluate(() => {
      const sends =
        (window as Window & { __nightfallWorkerSends?: any[] })
          .__nightfallWorkerSends ?? [];
      return sends.filter(
        (send) =>
          send?.module === "DeskCommand" &&
          send?.command?.type === "LoadDraftShowfile" &&
          send?.command?.data === "default",
      ).length;
    });
  expect(await draftLoadCount()).toBe(0);

  await expect(
    dialog.getByRole("button", { name: "Load Draft" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect.poll(draftLoadCount).toBe(1);
  await expect(page.locator("button[title='Menu']")).toBeVisible();
});

/** Verifies accepting a draft sends one load command and waits for it. */
test("load draft sends one startup draft load", async ({ page }) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page, {
    deferredCommands: ["LoadDraftShowfile"],
  });
  await routeShowfileDiscovery(
    page,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          showfiles: [
            {
              name: "default",
              path: "/tmp/default.nightfall-show",
              modified_ms: 1_700_000_000_000,
              draft: {
                showfile_name: "default",
                name: "default.nightfall-show",
                path: "/tmp/drafts/default.nightfall-show",
                modified_ms: 1_700_000_100_000,
                saved_modified_ms: 1_700_000_000_000,
              },
              revisions: [],
            },
          ],
        }),
      });
    },
    defaultDraftFixture,
  );

  await page.goto(
    "/?startup:draftRecovery=true&e2e=1&startup:bypassBackendReadiness=1",
  );
  const dialog = page.getByRole("dialog", {
    name: "Resume your work on default?",
  });
  await expect(dialog).toBeVisible();
  const draftLoadCount = async () =>
    page.evaluate(() => {
      const sends =
        (window as Window & { __nightfallWorkerSends?: any[] })
          .__nightfallWorkerSends ?? [];
      return sends.filter(
        (send) =>
          send?.module === "DeskCommand" &&
          send?.command?.type === "LoadDraftShowfile" &&
          send?.command?.data === "default",
      ).length;
    });
  expect(await draftLoadCount()).toBe(0);

  await dialog.getByRole("button", { name: "Load Draft" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("startup-splash")).toBeVisible();
  await expect.poll(draftLoadCount).toBe(1);
});

/** Verifies startup recovery can hand off to the normal showfile picker. */
test("opens another showfile from the startup draft prompt", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await routeShowfileDiscovery(
    page,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          showfiles: [
            {
              name: "default",
              path: "/tmp/default.nightfall-show",
              modified_ms: 1_700_000_000_000,
              draft: {
                showfile_name: "default",
                name: "default.nightfall-show",
                path: "/tmp/drafts/default.nightfall-show",
                modified_ms: 1_700_000_100_000,
                saved_modified_ms: 1_700_000_000_000,
              },
              revisions: [],
            },
            {
              name: "tour",
              path: "/tmp/tour.nightfall-show",
              modified_ms: 1_700_000_050_000,
              revisions: [],
            },
          ],
        }),
      });
    },
    defaultDraftFixture,
  );

  await page.goto(
    "/?startup:draftRecovery=true&e2e=1&startup:bypassBackendReadiness=1",
  );
  const recoveryDialog = page.getByRole("dialog", {
    name: "Resume your work on default?",
  });
  await expect(recoveryDialog).toBeVisible();

  await recoveryDialog.getByRole("button", { name: "Open Other..." }).click();
  await expect(recoveryDialog).toBeHidden();

  const pickerDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(pickerDialog).toBeVisible();
  await expect(page.locator("button[title='Menu']")).toHaveCount(0);
  await pickerDialog
    .getByRole("button", { name: "Show revisions for tour" })
    .click();
  await pickerDialog
    .getByRole("button", { name: "Open saved showfile tour" })
    .click();
  await expect(pickerDialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends =
          (window as Window & { __nightfallWorkerSends?: any[] })
            .__nightfallWorkerSends ?? [];
        return sends.some(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "LoadNamedShowfile" &&
            send?.command?.data === "tour",
        );
      }),
    )
    .toBe(true);
  await expect(page.getByTestId("status-showfile-name")).toContainText("tour");
});

/** Verifies startup recovery can start a new show before revealing the app. */
test("creates a new show from the startup draft prompt", async ({ page }) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await routeShowfileDiscovery(
    page,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          showfiles: [
            {
              name: "default",
              path: "/tmp/default.nightfall-show",
              modified_ms: 1_700_000_000_000,
              draft: {
                showfile_name: "default",
                name: "default.nightfall-show",
                path: "/tmp/drafts/default.nightfall-show",
                modified_ms: 1_700_000_100_000,
                saved_modified_ms: 1_700_000_000_000,
              },
              revisions: [],
            },
          ],
        }),
      });
    },
    defaultDraftFixture,
  );

  await page.goto(
    "/?startup:draftRecovery=true&e2e=1&startup:bypassBackendReadiness=1",
  );
  const recoveryDialog = page.getByRole("dialog", {
    name: "Resume your work on default?",
  });
  await expect(recoveryDialog).toBeVisible();

  const prompt = answerShowNamePrompt(page, "recovered-new");
  await recoveryDialog.getByRole("button", { name: "New showfile" }).click();
  await prompt;
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends =
          (window as Window & { __nightfallWorkerSends?: any[] })
            .__nightfallWorkerSends ?? [];
        return sends.some(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "NewNamedShowfile" &&
            send?.command?.data === "recovered-new",
        );
      }),
    )
    .toBe(true);
});

/** Verifies startup stays hidden until a picked showfile finishes loading. */
test("keeps startup shell hidden while another showfile load is pending", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page, {
    deferredCommands: ["LoadNamedShowfile"],
  });
  await routeShowfileDiscovery(
    page,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          showfiles: [
            {
              name: "default",
              path: "/tmp/default.nightfall-show",
              modified_ms: 1_700_000_000_000,
              draft: {
                showfile_name: "default",
                name: "default.nightfall-show",
                path: "/tmp/drafts/default.nightfall-show",
                modified_ms: 1_700_000_100_000,
                saved_modified_ms: 1_700_000_000_000,
              },
              revisions: [],
            },
            {
              name: "tour",
              path: "/tmp/tour.nightfall-show",
              modified_ms: 1_700_000_050_000,
              revisions: [],
            },
          ],
        }),
      });
    },
    defaultDraftFixture,
  );

  await page.goto(
    "/?startup:draftRecovery=true&e2e=1&startup:bypassBackendReadiness=1",
  );
  await page
    .getByRole("dialog", {
      name: "Resume your work on default?",
    })
    .getByRole("button", { name: "Open Other..." })
    .click();

  const pickerDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(pickerDialog).toBeVisible();
  await pickerDialog
    .getByRole("button", { name: "Show revisions for tour" })
    .click();
  await pickerDialog
    .getByRole("button", { name: "Open saved showfile tour" })
    .click();

  await expect(pickerDialog).toBeHidden();
  await expect(page.getByTestId("startup-splash")).toBeVisible();
  await expect(page.locator("button[title='Menu']")).toHaveCount(0);
});

/** Verifies initialized startup waits for an explicit saved showfile selection. */
test("prompts for a saved showfile when no startup draft is newer", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        showfiles: [
          {
            name: "tour",
            path: "/tmp/tour.nightfall-show",
            modified_ms: 1_700_000_000_000,
            revisions: [],
          },
        ],
      }),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.currentShowfileName", "tour");
  });

  await page.goto(
    "/?startup:draftRecovery=true&e2e=1&startup:bypassBackendReadiness=1",
  );

  await expect(page.getByTestId("startup-splash")).toBeHidden();
  const pickerDialog = page.getByRole("dialog", {
    name: "Resume your work on tour?",
  });
  await expect(pickerDialog).toBeVisible();
  await expect(page.locator("button[title='Menu']")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends =
          (window as Window & { __nightfallWorkerSends?: any[] })
            .__nightfallWorkerSends ?? [];
        return sends.some(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "LoadNamedShowfile",
        );
      }),
    )
    .toBe(false);

  await expect(
    pickerDialog.getByRole("button", { name: "Load Draft" }),
  ).toBeDisabled();
  await pickerDialog.getByRole("button", { name: "Keep Saved" }).click();
  await expect(pickerDialog).toBeHidden();
  await expect(page.locator("button[title='Menu']")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends =
          (window as Window & { __nightfallWorkerSends?: any[] })
            .__nightfallWorkerSends ?? [];
        return sends.some(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "LoadNamedShowfile" &&
            send?.command?.data === "tour",
        );
      }),
    )
    .toBe(true);
});

/** Verifies initialized startup can create a new show when no showfiles exist. */
test("creates a new startup show when no showfiles are available", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ showfiles: [] }),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.currentShowfileName", "tour");
  });

  await page.goto(
    "/?startup:draftRecovery=true&e2e=1&startup:bypassBackendReadiness=1",
  );

  await expect(page.getByTestId("startup-splash")).toBeHidden();
  const pickerDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(pickerDialog).toBeVisible();
  await expect(pickerDialog.getByText("No showfiles found.")).toBeVisible();
  await expect(page.locator("button[title='Menu']")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends =
          (window as Window & { __nightfallWorkerSends?: any[] })
            .__nightfallWorkerSends ?? [];
        return sends.some(
          (send) =>
            send?.module === "DeskCommand" &&
            (send?.command?.type === "LoadNamedShowfile" ||
              send?.command?.type === "LoadShowfile" ||
              send?.command?.type === "NewNamedShowfile" ||
              send?.command?.type === "NewShowfile"),
        );
      }),
    )
    .toBe(false);

  const prompt = answerShowNamePrompt(page, "startup-new");
  await pickerDialog.getByRole("button", { name: "New showfile" }).click();
  await prompt;
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends =
          (window as Window & { __nightfallWorkerSends?: any[] })
            .__nightfallWorkerSends ?? [];
        return sends.some(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "NewNamedShowfile" &&
            send?.command?.data === "startup-new",
        );
      }),
    )
    .toBe(true);
});

/** Verifies command-line showfile loads update the remembered startup name. */
test("remembers showfile loaded from the command line", async ({ page }) => {
  await captureWorkerSends(page);
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ showfiles: [] }),
    });
  });
  await page.goto("/?e2e=1");
  await expect(page.locator("button[title='Menu']")).toBeVisible();

  const commandLine = page.locator("#header-cmdline");
  await commandLine.fill("load tour");
  await commandLine.press("Enter");

  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("nightfall.currentShowfileName"),
      ),
    )
    .toBe("tour");
  await expect(page.getByTestId("status-showfile-name")).toContainText("tour");
});

/** Verifies connection status chrome does not flash when draft recovery unlocks the shell. */
test("does not show connection overlay immediately after startup draft recovery", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await routeShowfileDiscovery(
    page,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          showfiles: [
            {
              name: "default",
              path: "/tmp/default.nightfall-show",
              modified_ms: 1_700_000_000_000,
              draft: {
                showfile_name: "default",
                name: "default.nightfall-show",
                path: "/tmp/drafts/default.nightfall-show",
                modified_ms: 1_700_000_100_000,
                saved_modified_ms: 1_700_000_000_000,
              },
              revisions: [],
            },
          ],
        }),
      });
    },
    defaultDraftFixture,
  );

  await page.goto(
    "/?startup:draftRecovery=true&startup:bypassBackendReadiness=1",
  );
  const dialog = page.getByRole("dialog", {
    name: "Resume your work on default?",
  });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Load Draft" }).click();
  await expect(dialog).toBeHidden();
  expect(
    await page.locator('[data-overlay-kind="connection"]').isVisible(),
  ).toBe(false);
});

/** Verifies keeping the saved startup showfile discards the draft and reloads saved data. */
test("keeps saved startup showfile by discarding draft and loading saved copy", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await routeShowfileDiscovery(
    page,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          showfiles: [
            {
              name: "tour",
              path: "/tmp/tour.nightfall-show",
              modified_ms: 1_700_000_000_000,
              draft: {
                showfile_name: "tour",
                name: "tour.nightfall-show",
                path: "/tmp/drafts/tour.nightfall-show",
                modified_ms: 1_700_000_100_000,
                saved_modified_ms: 1_700_000_000_000,
              },
              revisions: [],
            },
          ],
        }),
      });
    },
    tourDraftFixture,
  );
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.currentShowfileName", "tour");
  });

  await page.goto(
    "/?startup:draftRecovery=true&e2e=1&startup:bypassBackendReadiness=1",
  );
  const dialog = page.getByRole("dialog", {
    name: "Resume your work on tour?",
  });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Keep Saved" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("startup-splash")).toBeHidden();
  await expect(page.locator("button[title='Menu']")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends =
          (window as Window & { __nightfallWorkerSends?: any[] })
            .__nightfallWorkerSends ?? [];
        const discardIndex = sends.findIndex(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "DiscardDraftShowfile" &&
            send?.command?.data === "tour",
        );
        const loadIndex = sends.findIndex(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "LoadNamedShowfile" &&
            send?.command?.data === "tour",
        );
        return discardIndex >= 0 && loadIndex > discardIndex;
      }),
    )
    .toBe(true);
});

/** Verifies saved startup recovery restores the prompt when backend commands fail. */
test("shows an error when keeping the saved startup showfile fails", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page, {
    commandResults: {
      DiscardDraftShowfile: {
        type: "Failed",
        data: {
          code: "showfile.discard_failed",
          message: "failed to discard draft",
          details: null,
        },
      },
    },
  });
  await routeShowfileDiscovery(
    page,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          showfiles: [
            {
              name: "tour",
              path: "/tmp/tour.nightfall-show",
              modified_ms: 1_700_000_000_000,
              draft: {
                showfile_name: "tour",
                name: "tour.nightfall-show",
                path: "/tmp/drafts/tour.nightfall-show",
                modified_ms: 1_700_000_100_000,
                saved_modified_ms: 1_700_000_000_000,
              },
              revisions: [],
            },
          ],
        }),
      });
    },
    tourDraftFixture,
  );
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.currentShowfileName", "tour");
  });

  await page.goto(
    "/?startup:draftRecovery=true&e2e=1&startup:bypassBackendReadiness=1",
  );
  const dialog = page.getByRole("dialog", {
    name: "Resume your work on tour?",
  });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Keep Saved" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(
    "failed to discard draft",
  );
  await expect(page.locator("button[title='Menu']")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends =
          (window as Window & { __nightfallWorkerSends?: any[] })
            .__nightfallWorkerSends ?? [];
        return sends.some(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "LoadNamedShowfile",
        );
      }),
    )
    .toBe(false);
});

/** Verifies choosing the saved startup showfile returns to the splash while work is pending. */
test("shows startup splash while keeping saved showfile is pending", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page, {
    deferredCommands: ["DiscardDraftShowfile"],
  });
  await routeShowfileDiscovery(
    page,
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          showfiles: [
            {
              name: "tour",
              path: "/tmp/tour.nightfall-show",
              modified_ms: 1_700_000_000_000,
              draft: {
                showfile_name: "tour",
                name: "tour.nightfall-show",
                path: "/tmp/drafts/tour.nightfall-show",
                modified_ms: 1_700_000_100_000,
                saved_modified_ms: 1_700_000_000_000,
              },
              revisions: [],
            },
          ],
        }),
      });
    },
    tourDraftFixture,
  );
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.currentShowfileName", "tour");
  });

  await page.goto(
    "/?startup:draftRecovery=true&e2e=1&startup:bypassBackendReadiness=1",
  );
  const dialog = page.getByRole("dialog", {
    name: "Resume your work on tour?",
  });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Keep Saved" }).click();
  await expect(dialog).toBeHidden();
  const splash = page.getByTestId("startup-splash");
  await expect(splash).toBeVisible();
  await expect(splash.getByText(/Loading saved showfile/)).toBeVisible();
});

test("opens a selected available showfile from the status bar menu", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        showfiles: [
          {
            name: "default",
            path: "/tmp/default.nightfall-show",
            modified_ms: 1_700_000_000_000,
            revisions: [],
          },
          {
            name: "tour",
            path: "/tmp/tour.nightfall-show",
            modified_ms: 1_700_000_600_000,
            revisions: [
              {
                name: "tour-20260520-010203.nightfall-show",
                path: "/tmp/backups/tour-20260520-010203.nightfall-show",
                modified_ms: 1_700_000_500_000,
              },
            ],
          },
        ],
      }),
    });
  });
  await page.goto("/?e2e=1&startup:bypassBackendReadiness=1");

  const startupDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(startupDialog).toBeVisible();
  const prompt = answerShowNamePrompt(page, "startup-picker-new");
  await startupDialog.getByRole("button", { name: "New showfile" }).click();
  await prompt;
  await expect(startupDialog).toBeHidden();
  await expect(page.locator("button[title='Menu']")).toBeVisible();

  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Open Showfile" }).click();

  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Show revisions for default" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Show revisions for tour" }),
  ).toBeVisible();
  await expect(dialog.getByText("Unknown")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Show revisions for tour" }).click();
  await dialog
    .getByRole("button", { name: "Open saved showfile tour" })
    .click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends = (window as Window & { __nightfallWorkerSends?: any[] })
          .__nightfallWorkerSends;
        return sends?.some(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "LoadNamedShowfile" &&
            send?.command?.data === "tour",
        );
      }),
    )
    .toBe(true);
  await expect(page.getByTestId("status-showfile-name")).toContainText("tour");
});

/** Verifies malformed showfiles remain visible and cannot dispatch load commands. */
test("badges and disables a showfile that failed to parse", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        showfiles: [
          {
            name: "default",
            path: "/tmp/default.nightfall-show",
            hasSavedSnapshot: true,
            modifiedMs: 1_700_000_000_000,
            revisions: [],
          },
          {
            name: "broken",
            path: "/tmp/broken.nightfall-show",
            hasSavedSnapshot: true,
            modifiedMs: 1_700_000_100_000,
            loadError:
              "failed to parse showfile /tmp/broken.nightfall-show/showfile.json",
            revisions: [],
          },
        ],
      }),
    });
  });
  await page.goto("/?e2e=1&startup:bypassBackendReadiness=1");

  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  const brokenGroup = dialog.getByRole("button", {
    name: "Show revisions for broken",
  });
  await expect(brokenGroup).toBeVisible();
  const errorBadge = dialog.getByRole("button", {
    name: "Copy showfile error: failed to parse showfile /tmp/broken.nightfall-show/showfile.json",
    exact: true,
  });
  await expect(errorBadge).toBeVisible();
  await expect(errorBadge).not.toHaveAttribute("title");
  await errorBadge.hover();

  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText(
    "failed to parse showfile /tmp/broken.nightfall-show/showfile.json",
  );
  await expect(tooltip).toHaveCSS("pointer-events", "auto");
  await errorBadge.focus();
  await expect(errorBadge).toBeFocused();
  await errorBadge.press("Enter");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("failed to parse showfile /tmp/broken.nightfall-show/showfile.json");
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await tooltip
    .getByRole("button", { name: "Copy showfile error", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("failed to parse showfile /tmp/broken.nightfall-show/showfile.json");
  await brokenGroup.click();

  const brokenShowfile = dialog.getByRole("button", {
    name: "Open saved showfile broken",
  });
  await expect(brokenShowfile).toBeDisabled();
  await expect(brokenShowfile).not.toHaveAttribute("title");
  await expect(
    dialog.getByRole("button", { name: "Show revisions for default" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => {
      const sends = (window as Window & { __nightfallWorkerSends?: any[] })
        .__nightfallWorkerSends;
      return sends?.some(
        (send) =>
          send?.module === "DeskCommand" &&
          send?.command?.type === "LoadNamedShowfile" &&
          send?.command?.data === "broken",
      );
    }),
  ).toBe(false);
});

/** Verifies shared revision rows remain readable in narrow dialogs and dispatch the selected backup. */
test("expands a showfile and opens a backup revision", async ({ page }) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        showfiles: [
          {
            name: "tour",
            path: "/tmp/tour.nightfall-show",
            modified_ms: 1_700_000_600_000,
            revisions: [
              {
                name: "tour-20260520-010203.nightfall-show",
                path: "/tmp/backups/tour-20260520-010203.nightfall-show",
                modified_ms: 1_700_000_500_000,
              },
            ],
          },
        ],
      }),
    });
  });
  await page.goto("/?e2e=1&startup:bypassBackendReadiness=1");

  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(dialog).toBeVisible();
  await dialog.getByText("tour", { exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Open saved showfile tour" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Load backup tour-20260520-010203.nightfall-show for tour",
    }),
  ).toBeVisible();
  await expect(
    dialog.getByText("backups/tour-20260520-010203.nightfall-show"),
  ).toBeVisible();
  await expect(dialog.getByText("Unknown")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("shared-showfile-revisions.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      dialog
        .getByRole("button", { name: "Hide revisions for tour" })
        .evaluate((row) => row.scrollWidth <= row.clientWidth),
    )
    .toBe(true);

  await page.screenshot({
    path: test.info().outputPath("shared-showfile-revisions-narrow.png"),
  });

  await dialog
    .getByRole("button", {
      name: "Load backup tour-20260520-010203.nightfall-show for tour",
    })
    .click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends = (window as Window & { __nightfallWorkerSends?: any[] })
          .__nightfallWorkerSends;
        return sends?.some(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "LoadShowfileRevision" &&
            send?.command?.data?.showfileName === "tour" &&
            send?.command?.data?.revisionName ===
              "tour-20260520-010203.nightfall-show",
        );
      }),
    )
    .toBe(true);
});

test("shows a saved revision when its timestamp is unknown", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        showfiles: [
          {
            name: "tour",
            path: "/tmp/tour.nightfall-show",
            has_saved_snapshot: true,
            modified_ms: null,
            revisions: [],
          },
        ],
      }),
    });
  });
  await page.goto("/?e2e=1&startup:bypassBackendReadiness=1");

  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Show revisions for tour" }).click();
  await expect(
    dialog.getByRole("button", { name: "Open saved showfile tour" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("tour.nightfall-show", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Unknown")).toHaveCount(2);
});

/** Verifies the showfile picker badges the group with the latest update. */
test("badges the most recently updated showfile group", async ({ page }) => {
  await disableE2eStartupAutoOpen(page);
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        showfiles: [
          {
            name: "default",
            path: "/tmp/default.nightfall-show",
            modified_ms: 1_700_000_600_000,
            revisions: [],
          },
          {
            name: "tour",
            path: "/tmp/tour.nightfall-show",
            modified_ms: 1_700_000_500_000,
            draft: {
              showfile_name: "tour",
              name: "tour.nightfall-show",
              path: "/tmp/drafts/tour.nightfall-show",
              modified_ms: 1_700_000_700_000,
              saved_modified_ms: 1_700_000_500_000,
            },
            revisions: [],
          },
        ],
      }),
    });
  });
  await page.goto("/?e2e=1&startup:bypassBackendReadiness=1");

  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Most recent")).toHaveCount(1);
  await expect(
    dialog
      .getByRole("button", { name: "Show revisions for tour" })
      .getByText("Most recent", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("button", { name: "Show revisions for default" })
      .getByText("Most recent"),
  ).toHaveCount(0);
});

test("expands a showfile and opens a draft", async ({ page }) => {
  await disableE2eStartupAutoOpen(page);
  await captureWorkerSends(page);
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        showfiles: [
          {
            name: "tour",
            path: "/tmp/tour.nightfall-show",
            modified_ms: 1_700_000_600_000,
            draft: {
              showfile_name: "tour",
              name: "tour.nightfall-show",
              path: "/tmp/drafts/tour.nightfall-show",
              modified_ms: 1_700_000_700_000,
              saved_modified_ms: 1_700_000_600_000,
            },
            revisions: [],
          },
        ],
      }),
    });
  });
  await page.goto("/?e2e=1&startup:bypassBackendReadiness=1");

  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Show revisions for tour" }).click();
  await expect(
    dialog.getByRole("button", { name: "Load draft for tour" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Revert to saved showfile tour" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("drafts/tour.nightfall-show", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("tour.nightfall-show", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Newer")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Load draft for tour" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sends = (window as Window & { __nightfallWorkerSends?: any[] })
          .__nightfallWorkerSends;
        return sends?.some(
          (send) =>
            send?.module === "DeskCommand" &&
            send?.command?.type === "LoadDraftShowfile" &&
            send?.command?.data === "tour",
        );
      }),
    )
    .toBe(true);
});

test("shows empty and error states for available showfiles", async ({
  page,
}) => {
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ showfiles: [] }),
    });
  });
  await page.goto("/?e2e=1");

  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Open Showfile" }).click();
  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(dialog.getByText("No showfiles found.")).toBeVisible();

  await page.unroute("**/api/showfiles");
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({ status: 500, body: "broken" });
  });
  await dialog
    .getByRole("button", { name: "Close open showfile dialog" })
    .click();
  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Open Showfile" }).click();
  await expect(dialog.getByText("Could not load showfiles.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retry" })).toBeVisible();
});
