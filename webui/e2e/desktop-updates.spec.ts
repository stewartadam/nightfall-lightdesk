// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Update status the stand-in desktop shell reports. */
interface UpdateState {
  canInstall: boolean;
  checkForUpdates: boolean;
  updateMode: "notify" | "download" | "install";
  phase:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing";
  version: string | null;
  progress: { downloadedBytes: number; totalBytes: number | null } | null;
  lastCheckedAt: number | null;
  error: {
    kind: "check" | "download" | "install" | "preferences";
    details: string;
  } | null;
  updatedTo: string | null;
}

/** Status of a published release with checks on and nothing waiting. */
const idle: UpdateState = {
  canInstall: true,
  checkForUpdates: true,
  updateMode: "download",
  phase: "idle",
  version: null,
  progress: null,
  lastCheckedAt: null,
  error: null,
  updatedTo: null,
};

/**
 * Loads the app as the desktop window, with a stand-in desktop shell that answers the update
 * commands from `initial` and records what the page asks of it. HTTP and WebSocket traffic use
 * the real backend.
 */
async function openDesktopApp(
  page: Page,
  backendPort: number,
  initial: UpdateState,
): Promise<void> {
  await page.addInitScript(
    ({ port, state }) => {
      const desktop = window as any;
      const callbacks = new Map<number, (event: unknown) => void>();
      const listeners: { event: string; handler: number }[] = [];
      let nextId = 1;
      desktop.__NIGHTFALL_BACKEND_PORT__ = port;
      desktop.updateState = state;
      desktop.updateCalls = [];
      /** Records pages the app opens, which the desktop shell hands to the system browser. */
      desktop.open = (url: string) => {
        desktop.updateCalls.push(`open:${url}`);
        return null;
      };
      /** Sends an update status change to the page, as the shell does after each step. */
      desktop.emitUpdateState = (next: unknown) => {
        desktop.updateState = next;
        for (const listener of listeners) {
          if (listener.event === "nightfall:update-state") {
            callbacks.get(listener.handler)?.({
              event: listener.event,
              id: listener.handler,
              payload: next,
            });
          }
        }
      };
      desktop.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        /** Registers the page callback a native event subscription delivers to. */
        transformCallback(callback: (event: unknown) => void) {
          const id = nextId++;
          callbacks.set(id, callback);
          return id;
        },
        /** Answers event subscriptions and the update commands, recording each update call. */
        async invoke(command: string, args: Record<string, any>) {
          if (command === "plugin:event|listen") {
            listeners.push({ event: args.event, handler: args.handler });
            return nextId++;
          }
          if (command === "plugin:event|unlisten") return;
          if (command === "update_state") return desktop.updateState;
          if (command === "set_update_checks") {
            if (desktop.failUpdateChecks) {
              throw new Error("Could not save the update setting");
            }
            desktop.updateCalls.push(`set_update_checks:${args.enabled}`);
            desktop.updateState = {
              ...desktop.updateState,
              checkForUpdates: args.enabled,
            };
            return desktop.updateState;
          }
          if (command === "set_update_mode") {
            desktop.updateCalls.push(`set_update_mode:${args.mode}`);
            desktop.updateState = {
              ...desktop.updateState,
              updateMode: args.mode,
            };
            return desktop.updateState;
          }
          if (command === "download_update") {
            desktop.updateCalls.push("download_update");
            return desktop.updateState;
          }
          if (command === "check_for_updates") {
            desktop.updateCalls.push("check_for_updates");
            return desktop.updateState;
          }
          if (command === "restart_to_update") {
            desktop.updateCalls.push("restart_to_update");
            return;
          }
          throw new Error(`Unexpected native command: ${command}`);
        },
      };
      desktop.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        /** Releases stand-in subscriptions when the page disposes its shell. */
        unregisterListener() {},
      };
    },
    { port: backendPort, state: initial },
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
}

/** Returns the update commands the page has sent to the stand-in shell. */
function updateCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).updateCalls);
}

/** Verifies the restart notice appears only once an update is downloaded and restarts on request. */
test("desktop app offers a downloaded update without installing it", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openDesktopApp(page, backendSlot.backendPort, idle);
  const notice = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Update ready" });
  await expect(notice).toHaveCount(0);

  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...idle,
    phase: "downloading",
    version: "0.1.0-alpha.4",
  });
  await expect(notice).toHaveCount(0);
  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...idle,
    phase: "ready",
    version: "0.1.0-alpha.4",
  });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    "Nightfall 0.1.0-alpha.4 is ready to install",
  );
  await page.screenshot({ path: testInfo.outputPath("update-notice.png") });
  expect(await updateCalls(page)).toEqual([]);

  await notice.getByRole("button", { name: "Restart to update" }).click();
  await expect.poll(() => updateCalls(page)).toEqual(["restart_to_update"]);
});

/** Later puts off a version's notice for a day, across reloads, while newer versions still show. */
test("later snoozes the update notice for that version", async ({
  page,
  backendSlot,
}) => {
  const ready = { ...idle, phase: "ready", version: "0.1.0-alpha.4" } as const;
  await openDesktopApp(page, backendSlot.backendPort, ready);
  const notice = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Update ready" });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Later" }).click();
  await expect(notice).toHaveCount(0);

  await page.reload();
  await waitForDockviewApp(page);
  await expect(notice).toHaveCount(0);
  const about = await openAbout(page);
  await expect(
    about.getByRole("button", { name: "Restart to update" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...ready,
    version: "0.1.0-alpha.5",
  });
  await expect(notice).toContainText("Nightfall 0.1.0-alpha.5");

  // A day later the snoozed version is announced again.
  await page.evaluate(() => {
    localStorage.setItem(
      "nightfall-update-notice-snoozes",
      JSON.stringify({
        ready: { version: "0.1.0-alpha.4", until: Date.now() - 1 },
      }),
    );
  });
  await page.reload();
  await waitForDockviewApp(page);
  await expect(notice).toContainText("Nightfall 0.1.0-alpha.4");
  expect(await updateCalls(page)).toEqual([]);
});

/** Opens the About dialog from the app menu and returns it. */
async function openAbout(page: Page) {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  const about = page.getByRole("dialog", { name: "About nightfall" });
  await expect(about).toBeVisible();
  return about;
}

/** Verifies the check row names every update state and keeps one height while the state changes. */
test("about update status keeps its height in every state", async ({
  page,
  backendSlot,
}) => {
  await openDesktopApp(page, backendSlot.backendPort, idle);
  const about = await openAbout(page);
  const status = about
    .getByRole("region", { name: "Updates" })
    .getByTestId("update-status");
  const version = "0.1.0-alpha.4";
  const states: [Partial<UpdateState>, string][] = [
    [{}, "Updates haven't been checked yet"],
    [{ phase: "checking" }, "Checking for updates…"],
    [{ lastCheckedAt: 1_792_000_000 }, "Nightfall is up to date"],
    [
      { error: { kind: "check", details: "offline" } },
      "Couldn't check for updates",
    ],
    [{ phase: "available", version }, "An update is available"],
    [{ phase: "downloading", version }, "An update is available"],
    [{ phase: "ready", version }, "An update is available"],
    [{ phase: "installing", version }, "An update is available"],
    [{ checkForUpdates: false }, "Update checks are off"],
  ];
  const heights = new Set<number>();
  for (const [change, headline] of states) {
    await page.evaluate((state) => (window as any).emitUpdateState(state), {
      ...idle,
      ...change,
    });
    await expect(status.locator("p").first()).toHaveText(headline);
    heights.add((await status.boundingBox())?.height ?? 0);
  }
  expect([...heights]).toHaveLength(1);
});
/**
 * Verifies the About dialog checks for updates on request, shows download progress, offers the
 * restart once an update is ready, and saves the choice to install on quit.
 */
test("about dialog checks for and installs updates", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openDesktopApp(page, backendSlot.backendPort, {
    ...idle,
    lastCheckedAt: Date.UTC(2026, 9, 13, 17, 30) / 1000,
  });
  const about = await openAbout(page);
  const updates = about.getByRole("region", { name: "Updates" });
  const status = updates.getByTestId("update-status");
  const check = about.getByRole("button", { name: "Check for Updates" });
  await expect(status).toContainText("Nightfall is up to date");
  await expect(status).toContainText("Last checked Oct 13, 2026");
  await expect(updates.getByTestId("update-alert")).toHaveCount(0);
  await about.screenshot({ path: testInfo.outputPath("about-updates.png") });

  await check.click();
  await expect.poll(() => updateCalls(page)).toEqual(["check_for_updates"]);
  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...idle,
    phase: "downloading",
    version: "0.1.0-alpha.4",
    progress: { downloadedBytes: 0, totalBytes: null },
  });
  await expect(
    updates.getByRole("progressbar", { name: "Update download progress" }),
  ).toBeVisible();
  await expect(updates).toContainText("0.0 MB");
  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...idle,
    phase: "downloading",
    version: "0.1.0-alpha.4",
    progress: { downloadedBytes: 21_400_000, totalBytes: 48_200_000 },
  });
  const alert = updates.getByTestId("update-alert");
  await expect(alert).toContainText("Downloading Nightfall 0.1.0-alpha.4");
  await expect(check).toBeDisabled();
  await expect(
    updates.getByRole("progressbar", { name: "Update download progress" }),
  ).toBeVisible();
  await expect(updates).toContainText("21.4 MB of 48.2 MB");
  await about.screenshot({
    path: testInfo.outputPath("about-updates-downloading.png"),
  });

  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...idle,
    phase: "ready",
    version: "0.1.0-alpha.4",
  });
  await expect(alert).toContainText(
    "Nightfall 0.1.0-alpha.4 is ready to install",
  );
  await expect(updates.getByRole("progressbar")).toHaveCount(0);
  // A newer release may have replaced the downloaded one, so checking stays available.
  await expect(check).toBeEnabled();
  // While that check runs, the downloaded update stays announced with its restart held.
  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...idle,
    phase: "checking",
    version: "0.1.0-alpha.4",
  });
  await expect(status).toContainText("Checking for updates");
  await expect(alert).toContainText(
    "Nightfall 0.1.0-alpha.4 is ready to install",
  );
  await expect(
    alert.getByRole("button", { name: "Restart to update" }),
  ).toBeDisabled();
  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...idle,
    phase: "ready",
    version: "0.1.0-alpha.4",
  });
  await about.screenshot({
    path: testInfo.outputPath("about-updates-ready.png"),
  });

  const mode = updates.getByRole("combobox", {
    name: "When an update is available",
  });
  await expect(mode).toHaveValue("download");
  await mode.selectOption("install");
  await expect(mode).toHaveValue("install");
  await expect(alert).toContainText(
    "Update applied when you next quit Nightfall.",
  );

  await updates.getByRole("button", { name: "Restart to update" }).click();
  await expect
    .poll(() => updateCalls(page))
    .toEqual([
      "check_for_updates",
      "set_update_mode:install",
      "restart_to_update",
    ]);
});

/**
 * Verifies that in notify mode a found version waits for the operator, who can
 * download it from the notice or About, and that a failed download reads as a plain sentence
 * with the underlying error beneath it and a Try Again button.
 */
test("updates wait to download in notify mode", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openDesktopApp(page, backendSlot.backendPort, idle);
  const about = await openAbout(page);
  const updates = about.getByRole("region", { name: "Updates" });
  const mode = updates.getByRole("combobox", {
    name: "When an update is available",
  });
  await expect(mode).toHaveValue("download");
  await mode.selectOption("notify");
  await expect
    .poll(() => updateCalls(page))
    .toEqual(["set_update_mode:notify"]);

  const available = {
    ...idle,
    updateMode: "notify",
    phase: "available",
    version: "0.1.0-alpha.4",
  };
  await page.evaluate(
    (state) => (window as any).emitUpdateState(state),
    available,
  );
  await expect(updates.getByTestId("update-status")).toHaveText(
    "An update is availableLast checked: Never",
  );
  await expect(updates.getByTestId("update-alert")).toContainText(
    "Nightfall 0.1.0-alpha.4 is available",
  );
  const notice = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Update available" });
  await expect(notice).toBeVisible();
  await about.screenshot({
    path: testInfo.outputPath("about-updates-available.png"),
  });

  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...available,
    error: { kind: "download", details: "HTTP status 404 Not Found" },
  });
  await expect(updates.getByTestId("update-alert")).toContainText(
    "Couldn't download the update. Try again.",
  );
  await expect(updates.getByTestId("update-error-details")).toHaveText(
    "HTTP status 404 Not Found",
  );
  await about.screenshot({
    path: testInfo.outputPath("about-updates-error.png"),
  });

  await updates.getByRole("button", { name: "Try Again" }).click();
  await expect
    .poll(() => updateCalls(page))
    .toEqual(["set_update_mode:notify", "download_update"]);
});

/**
 * Verifies that a launch after an update says so once, and that an update that failed to install
 * is explained with its error and offers Try Again, which restarts into it again.
 */
test("the next launch reports an installed or failed update", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openDesktopApp(page, backendSlot.backendPort, {
    ...idle,
    updatedTo: "0.1.0-alpha.4",
  });
  const toasts = page.locator('[data-component="Toast"]');
  await expect(toasts.filter({ hasText: "Nightfall updated" })).toContainText(
    "You're now running Nightfall 0.1.0-alpha.4.",
  );

  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...idle,
    phase: "ready",
    version: "0.1.0-alpha.5",
    error: {
      kind: "install",
      details: "Nightfall 0.1.0-alpha.5: invalid gzip header",
    },
  });
  const notice = toasts.filter({ hasText: "Update couldn't install" });
  await expect(notice).toContainText(
    "Nightfall 0.1.0-alpha.5 couldn't be installed",
  );
  const about = await openAbout(page);
  const updates = about.getByRole("region", { name: "Updates" });
  await expect(updates.getByTestId("update-alert")).toContainText(
    "Couldn't install Nightfall 0.1.0-alpha.5Nightfall kept this version. Try again.",
  );
  await expect(updates.getByTestId("update-error-details")).toHaveText(
    "Nightfall 0.1.0-alpha.5: invalid gzip header",
  );
  await expect(updates.getByTestId("update-error")).toHaveCount(0);
  await about.screenshot({
    path: testInfo.outputPath("about-updates-install-failed.png"),
  });
  await updates.getByRole("button", { name: "Try Again" }).click();
  await expect.poll(() => updateCalls(page)).toEqual(["restart_to_update"]);
});

/**
 * Verifies the Settings > Privacy switch turns update checks off, and that the About dialog
 * then refuses to check.
 */
test("privacy settings turn update checks off", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openDesktopApp(page, backendSlot.backendPort, idle);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("tab", { name: "Privacy" }).click();
  const updates = settings.getByRole("region", { name: "Updates" });
  await updates.scrollIntoViewIfNeeded();
  const checks = updates.getByRole("switch", { name: "Allow update checks" });
  await expect(checks).toBeChecked();
  await expect(updates.getByRole("switch")).toHaveCount(1);
  await expect(
    updates.getByRole("heading", { name: "Allow update checks", exact: true }),
  ).toBeVisible();
  await expect(updates).not.toContainText("IP address");
  await settings.screenshot({
    path: testInfo.outputPath("privacy-updates.png"),
  });

  await page.evaluate(() => {
    (window as any).failUpdateChecks = true;
  });
  await checks.click();
  const checksError = updates.getByRole("alert");
  await expect(checksError).toContainText("Could not save the update setting");
  await expect(checksError).toHaveAttribute("data-variant", "caution");
  await settings.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("privacy-updates-error.png"),
  });
  await page.evaluate(() => {
    (window as any).failUpdateChecks = false;
  });
  // Reopen Settings so the switch shows the saved choice again after the failed save.
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await page.keyboard.press("ControlOrMeta+,");
  await settings.getByRole("tab", { name: "Privacy" }).click();
  await updates.scrollIntoViewIfNeeded();
  await expect(checks).toBeChecked();

  await checks.setChecked(false);
  await expect(checks).not.toBeChecked();
  await expect(checksError).toHaveCount(0);
  await expect
    .poll(() => updateCalls(page))
    .toEqual(["set_update_checks:false"]);
  await page.keyboard.press("Escape");

  const about = await openAbout(page);
  await expect(
    about.getByRole("button", { name: "Check for Updates" }),
  ).toBeDisabled();
  await expect(
    about.getByRole("region", { name: "Updates" }).getByTestId("update-status"),
  ).toHaveText("Update checks are offTurn them on in Settings > Privacy.");
  await about.screenshot({
    path: testInfo.outputPath("about-updates-off.png"),
  });
});

/**
 * Verifies a desktop build that cannot install updates still checks, hides the update mode
 * choice, and sends the operator to the downloads page for a newer version, from About
 * and from the notice.
 */
test("builds that cannot install updates check and link to downloads", async ({
  page,
  backendSlot,
}, testInfo) => {
  const checkOnly = { ...idle, canInstall: false };
  await openDesktopApp(page, backendSlot.backendPort, checkOnly);
  const about = await openAbout(page);
  const updates = about.getByRole("region", { name: "Updates" });
  await expect(updates).toContainText(
    "This build of Nightfall can't install updates itself.",
  );
  await expect(updates.getByRole("combobox")).toHaveCount(0);
  await updates.getByRole("button", { name: "Check for Updates" }).click();
  await expect.poll(() => updateCalls(page)).toEqual(["check_for_updates"]);

  await page.evaluate((state) => (window as any).emitUpdateState(state), {
    ...checkOnly,
    phase: "available",
    version: "0.1.0-alpha.4",
  });
  await expect(updates.getByTestId("update-alert")).toContainText(
    "Download it from nightfall.live/downloads.",
  );
  await expect(
    updates.getByRole("button", { name: "Download", exact: true }),
  ).toHaveCount(0);
  const notice = page
    .locator('[data-component="Toast"]')
    .filter({ hasText: "Update available" });
  await expect(notice).toContainText(
    "Nightfall 0.1.0-alpha.4 is available from nightfall.live/downloads.",
  );
  await about.screenshot({
    path: testInfo.outputPath("about-updates-check-only.png"),
  });
  await updates.getByRole("button", { name: "Go to Downloads" }).click();
  await expect
    .poll(() => updateCalls(page))
    .toEqual(["check_for_updates", "open:https://nightfall.live/downloads"]);
  await about.getByRole("button", { name: "Close about dialog" }).click();

  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("tab", { name: "Privacy" }).click();
  await expect(
    settings
      .getByRole("region", { name: "Updates" })
      .getByRole("switch", { name: "Allow update checks" }),
  ).toBeChecked();
});

/** Verifies the browser UI, which has nothing to update, shows no update controls. */
test("update controls stay hidden outside the desktop app", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  const about = await openAbout(page);
  await expect(about.getByRole("region", { name: "Updates" })).toHaveCount(0);
  await expect(
    about.getByRole("button", { name: "Check for Updates" }),
  ).toHaveCount(0);
});
