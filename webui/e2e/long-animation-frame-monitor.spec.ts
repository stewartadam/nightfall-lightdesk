// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

/**
 * Waits until the dev app store bridge is available to browser-side assertions.
 */
async function waitForAppStores(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).appStores));
}

/**
 * Opens a dockview panel through the command palette.
 */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

test("long animation frame monitor publishes LoAF stats for instrumentation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const observeRecords: Array<{ buffered?: boolean; type?: string }> = [];

    class FakePerformanceObserver {
      static supportedEntryTypes = ["long-animation-frame"];

      private readonly callback: PerformanceObserverCallback;

      /** Store the observer callback so the fake can emit deterministic entries. */
      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback;
      }

      /** Records the observed type and emits a single long animation frame entry. */
      observe(options: PerformanceObserverInit): void {
        observeRecords.push({
          buffered: options.buffered,
          type: options.type,
        });

        setTimeout(() => {
          this.callback(
            {
              getEntries: () => [
                {
                  name: "long-animation-frame",
                  entryType: "long-animation-frame",
                  startTime: 10,
                  duration: 72,
                  blockingDuration: 21,
                  renderStart: 20,
                  styleAndLayoutStart: 30,
                  firstUIEventTimestamp: 0,
                  scripts: [
                    {
                      duration: 45,
                      executionStart: 15,
                      forcedStyleAndLayoutDuration: 3,
                      invoker: "requestAnimationFrame",
                      invokerType: "event-listener",
                      sourceCharPosition: 123,
                      sourceFunctionName: "renderScene",
                      sourceURL: "http://localhost/src/render.ts",
                      windowAttribution: "self",
                    },
                  ],
                },
              ],
            } as unknown as PerformanceObserverEntryList,
            this as unknown as PerformanceObserver,
          );
        }, 0);
      }

      /** Matches the native observer API for cleanup calls. */
      disconnect(): void {}

      /** Matches the native observer API for callers that drain pending records. */
      takeRecords(): PerformanceEntry[] {
        return [];
      }
    }

    Object.defineProperty(window, "__loafObserveRecords", {
      configurable: true,
      value: observeRecords,
    });
    Object.defineProperty(window, "PerformanceObserver", {
      configurable: true,
      value: FakePerformanceObserver,
      writable: true,
    });
  });

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");
  await waitForAppStores(page);

  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__loafObserveRecords?.[0]?.type),
    )
    .toBe("long-animation-frame");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).appStores.longAnimationFrameStats.get()
              ?.totalFrames,
        ),
      { timeout: 4_000 },
    )
    .toBe(1);

  await openPanel(page, "Instrumentation");
  await expect(page.getByText("Instrumentation").first()).toBeVisible();
  await page
    .getByRole("button", { name: /Browser Rendering/ })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByText("Long frames")).toBeVisible();
});
