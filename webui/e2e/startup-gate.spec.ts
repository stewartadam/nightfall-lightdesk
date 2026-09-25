// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { routeShowfileDiscovery } from "./showfile-startup";

/** Installs a controllable websocket worker mock before the app imports its worker module. */
async function installFakeWebsocketWorker(
  page: Page,
  initialAppState: "Initialized" | "Ready" = "Ready",
  succeedWorldSwap = false,
) {
  await page.addInitScript(
    ({ appState, succeedWorldSwap }) => {
      type QueuedWorkerMessage = {
        data: unknown;
        postedAtMs: number;
        deliveryMessageId: number;
      };

      class FakeWebsocketWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        private queue: QueuedWorkerMessage[] = [];
        private nextDeliveryMessageId = 1;

        /** Queue one decoded backend message for the next pullFrame request. */
        emitBackendMessage(data: unknown): void {
          this.queue.push({
            data,
            postedAtMs: performance.timeOrigin + performance.now(),
            deliveryMessageId: this.nextDeliveryMessageId++,
          });
        }

        /** Dispatch one worker control message to the app. */
        emitWorkerMessage(data: unknown): void {
          this.onmessage?.(new MessageEvent("message", { data }));
        }

        /** Emulates the subset of the websocket worker protocol used by the app. */
        postMessage(message: unknown): void {
          const envelope = message as {
            type?: string;
            data?: {
              command_id?: unknown;
              module?: string;
              command?: { type?: string; data?: unknown };
            };
          };
          if (envelope.type === "start") {
            window.setTimeout(() => {
              this.emitWorkerMessage({ type: "status", status: "connected" });
              this.emitWorkerMessage({ type: "connected" });
              this.emitBackendMessage({ type: "AppState", data: appState });
              this.emitBackendMessage({ type: "ResyncComplete" });
              this.flush();
            }, 0);
            return;
          }

          const worldSwapCommands = new Set([
            "LoadDraftShowfile",
            "LoadNamedShowfile",
            "LoadShowfile",
            "NewNamedShowfile",
            "NewShowfile",
          ]);
          if (
            envelope.type === "submit" &&
            (succeedWorldSwap ||
              (
                window as Window & {
                  __nightfallDisconnectWorldSwapCommands?: boolean;
                }
              ).__nightfallDisconnectWorldSwapCommands === true) &&
            envelope.data?.module === "DeskCommand" &&
            worldSwapCommands.has(envelope.data.command?.type ?? "")
          ) {
            const command = envelope.data.command;
            if (succeedWorldSwap) {
              this.emitBackendMessage({
                type: "CommandResult",
                data: {
                  command_id: envelope.data.command_id,
                  outcome: { type: "Succeeded", data: {} },
                },
              });
              this.emitBackendMessage({ type: "AppState", data: "Ready" });
              this.emitBackendMessage({ type: "ResyncComplete" });
              this.flush();
            } else {
              this.emitWorkerMessage({
                type: "status",
                status: "disconnected",
              });
            }
            const changeId = crypto.randomUUID();
            (
              window as Window & {
                __nightfallCompleteWorldSwap?: (
                  confirmedShowfileName?: string,
                ) => void;
              }
            ).__nightfallCompleteWorldSwap = (confirmedShowfileName) => {
              const showfileName =
                confirmedShowfileName ??
                (typeof command?.data === "string" ? command.data : "default");
              this.emitWorkerMessage({ type: "status", status: "connected" });
              this.emitWorkerMessage({ type: "connected" });
              this.emitBackendMessage({
                type: "UiNotification",
                data: {
                  type: "CurrentShowfileChanged",
                  data: {
                    name: showfileName,
                    change_id: confirmedShowfileName
                      ? crypto.randomUUID()
                      : changeId,
                  },
                },
              });
              this.emitBackendMessage({ type: "AppState", data: "Ready" });
              this.emitBackendMessage({ type: "ResyncComplete" });
              this.flush();
            };
            return;
          }

          if (envelope.type === "pullFrame") {
            this.flush();
          }
        }

        /** Stops the fake worker without touching queued browser state. */
        terminate(): void {
          this.queue = [];
        }

        /** Sends queued backend messages as a worker message batch. */
        private flush(): void {
          const messages = this.queue.splice(0, this.queue.length);
          this.emitWorkerMessage({ type: "messageBatch", messages });
        }
      }

      const workers: FakeWebsocketWorker[] = [];
      const NativeWorker = window.Worker;
      Object.defineProperty(window, "__nightfallFakeWorkers", {
        configurable: true,
        value: workers,
      });
      Object.defineProperty(window, "Worker", {
        configurable: true,
        value: new Proxy(NativeWorker, {
          construct(target, args: [string | URL, WorkerOptions | undefined]) {
            const [scriptUrl, options] = args;
            if (!/engine-runtime-(?:demo-)?worker/.test(String(scriptUrl))) {
              return Reflect.construct(target, [scriptUrl, options]);
            }

            const worker = new FakeWebsocketWorker();
            workers.push(worker);
            return worker;
          },
        }),
      });
    },
    { appState: initialAppState, succeedWorldSwap },
  );
}

/** Disables the global E2E startup auto-open storage state for startup tests. */
async function disableE2eStartupAutoOpen(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall.e2eAutoOpenStartupShowfile",
      "false",
    );
  });
}

/** Makes the fake worker drop world-swap command results until the test resyncs it. */
async function disconnectStartupWorldSwapCommands(page: Page) {
  await page.addInitScript(() => {
    (
      window as Window & {
        __nightfallDisconnectWorldSwapCommands?: boolean;
      }
    ).__nightfallDisconnectWorldSwapCommands = true;
  });
}

/** Verifies the static bootstrap document paints the splash before Solid mounts. */
test("bootstrap html presents startup splash before app shell mounts", async ({
  page,
}, testInfo) => {
  await page.route("**/main.tsx", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: "",
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator("main#app")).toBeVisible();
  await expect(page.locator("#bootstrap-splash")).toBeVisible();
  await expect(page).toHaveTitle("nightfall");
  await page.screenshot({
    path: testInfo.outputPath("bootstrap-branding.png"),
  });
  await expect(
    page.getByRole("status", { name: "Starting nightfall" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "nightfall" })).toBeVisible();
  await expect(page.getByText("Starting nightfall")).toBeVisible();
  await expect(page.getByRole("img", { name: "nightfall logo" })).toBeVisible();
  const bootstrapFaders = page.locator("#bootstrap-splash .bootstrap-fader");
  await expect(bootstrapFaders).toHaveCount(3);
  await expect
    .poll(() =>
      bootstrapFaders
        .first()
        .evaluate((element) => getComputedStyle(element).animationName),
    )
    .toBe("bootstrap-fader-left");
  await expect(page.getByRole("navigation", { name: "Global" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open command palette" }),
  ).toHaveCount(0);
});

/** Verifies the splash has a larger beat-synced logo and bottom build metadata. */
test("startup splash presents beat-synced logo faders and bottom build metadata", async ({
  page,
}, testInfo) => {
  await disableE2eStartupAutoOpen(page);
  await installFakeWebsocketWorker(page, "Initialized");
  let releaseShowfiles: () => void = () => {};
  const showfilesBlocked = new Promise<void>((resolve) => {
    releaseShowfiles = resolve;
  });
  const showfilesRequested = new Promise<void>((resolve) => {
    routeShowfileDiscovery(page, async (route) => {
      resolve();
      await showfilesBlocked;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ showfiles: [] }),
      });
    });
  });

  await page.goto("/?startup:draftRecovery=true&e2e=1");
  await showfilesRequested;

  const splash = page.getByTestId("startup-splash");
  await expect(splash).toBeVisible();

  await expect(
    splash.getByRole("heading", { name: "nightfall", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("startup-branding.png") });
  const logo = splash.getByRole("img", { name: "nightfall logo" });
  await expect(logo).toBeVisible();
  const logoShell = splash.getByTestId("startup-logo-shell");
  await expect(logoShell).toBeVisible();
  await expect
    .poll(() =>
      logoShell.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .not.toBe("none");
  const logoBox = await logo.boundingBox();
  expect(logoBox?.width).toBeGreaterThan(120);

  const faders = logo.locator(".nightfall-splash-fader");
  await expect(faders).toHaveCount(3);
  const initialTransforms = await faders.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).transform),
  );
  const statusLine = splash.locator("p.text-lg");
  await expect(statusLine).toHaveCount(1);
  await expect(statusLine).toHaveClass(/text-lg/);
  const statusDots = splash.getByTestId("startup-status-dots");
  const dots = statusDots.locator(".startup-status-dot");
  await expect(dots).toHaveCount(3);
  await expect(dots.first()).toBeVisible();
  await expect(dots.nth(1)).toBeVisible();
  await expect(dots.nth(2)).toBeVisible();
  const animationDetails = await dots.evaluateAll((elements) =>
    elements.map((element) => {
      const animation = element.getAnimations()[0];
      return {
        delay: getComputedStyle(element).animationDelay,
        keyframeProperties:
          (animation?.effect as KeyframeEffect | null)
            ?.getKeyframes()
            .flatMap((keyframe) => Object.keys(keyframe)) ?? [],
        name: getComputedStyle(element).animationName,
      };
    }),
  );
  expect(animationDetails.map(({ name }) => name)).toEqual([
    "startup-status-dot-chase",
    "startup-status-dot-chase",
    "startup-status-dot-chase",
  ]);
  expect(animationDetails.map(({ delay }) => delay)).toEqual([
    "0s",
    "0.3s",
    "0.6s",
  ]);
  for (const { keyframeProperties } of animationDetails) {
    expect(keyframeProperties).toContain("transform");
    expect(keyframeProperties).not.toContain("width");
    expect(keyframeProperties).not.toContain("height");
  }
  await expect.poll(() => logo.getAttribute("data-beat")).toMatch(/^[1-3]$/);
  await expect
    .poll(() =>
      faders.evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).transform),
      ),
    )
    .not.toEqual(initialTransforms);
  await expect
    .poll(() =>
      faders
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration),
    )
    .toContain("0.22s");

  const bootstrapPage = await page.context().newPage();
  await bootstrapPage.route("**/main.tsx", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await bootstrapPage.goto("/", { waitUntil: "domcontentloaded" });
  const bootstrap = bootstrapPage.locator("#bootstrap-splash");
  /** Captures typography and layout properties that must survive the handoff. */
  const appearance = (element: Element) => {
    const style = getComputedStyle(element);
    return {
      font: style.font,
      color: style.color,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    };
  };
  expect(await bootstrap.locator("h1").evaluate(appearance)).toEqual(
    await splash.locator("h1").evaluate(appearance),
  );
  expect(await bootstrap.locator("svg").evaluate(appearance)).toEqual(
    await logo.evaluate(appearance),
  );
  expect(
    await bootstrap.locator(".bootstrap-status-dots").evaluate(appearance),
  ).toEqual(await statusDots.evaluate(appearance));
  expect(
    await bootstrap.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(await splash.evaluate((el) => getComputedStyle(el).backgroundColor));
  await expect(bootstrap.locator(".startup-status-dot")).toHaveCount(3);
  await bootstrapPage.screenshot({
    path: testInfo.outputPath("bootstrap-parity.png"),
  });
  await bootstrapPage.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  for (const animated of await bootstrap
    .locator(".bootstrap-fader, .startup-status-dot")
    .all()) {
    await expect(animated).toHaveCSS("animation-name", "none");
  }
  await bootstrapPage.close();

  const metadata = splash.getByText(/^v.+\(.+\)$/);
  await expect(metadata).toBeVisible();
  const bootstrapHtml = await (await page.request.get("/")).text();
  const bootstrapMetadata = bootstrapHtml.match(
    /<p class="bootstrap-build-metadata">([^<]+)<\/p>/,
  )?.[1];
  expect(bootstrapMetadata).toBe(await metadata.textContent());
  await expect(splash.getByText(/^engine v/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("startup-metadata.png") });
  const metadataBox = await metadata.boundingBox();
  const viewport = page.viewportSize();
  expect(metadataBox?.y).toBeGreaterThan((viewport?.height ?? 0) - 100);

  releaseShowfiles();
  await expect(splash).toBeHidden();
});

/** Verifies quick startup paths keep the splash visible for the minimum hold time. */
test("startup splash stays visible for at least one second", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await installFakeWebsocketWorker(page, "Initialized");
  await page.clock.install({ time: 0 });
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ showfiles: [] }),
    });
  });

  await page.goto("/?startup:draftRecovery=true&e2e=1");
  const splash = page.getByTestId("startup-splash");
  await expect(splash).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Open Showfile" }),
  ).toBeVisible();

  await page.clock.runFor(999);
  await expect(splash).toBeVisible();

  await page.clock.runFor(301);
  await expect(splash).toBeHidden();
});

for (const succeedWorldSwap of [false, true]) {
  /** Verifies startup waits for confirmed identity after either a result or disconnect. */
  test(`keeps startup splash visible until world-swap showfile confirmation (${succeedWorldSwap ? "success" : "disconnect"})`, async ({
    page,
  }, testInfo) => {
    await disableE2eStartupAutoOpen(page);
    await disconnectStartupWorldSwapCommands(page);
    await installFakeWebsocketWorker(page, "Initialized", succeedWorldSwap);
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

    await page.goto("/?startup:draftRecovery=true&e2e=1");
    const picker = page.getByRole("dialog", { name: "Open Showfile" });
    await expect(picker).toBeVisible();
    /** Reads the backend-confirmed showfile generation from the running app. */
    const readRevision = () =>
      page.evaluate(async () => {
        const showfile = await import(
          /* @vite-ignore */ "/lib/showfile-loading.ts"
        );
        return showfile.currentShowfileRevision.get();
      });
    const initialRevision = await readRevision();
    await page.evaluate(async () => {
      const settings = await import(/* @vite-ignore */ "/state/settings.ts");
      const snapshots = await import(
        /* @vite-ignore */ "/state/io-snapshots.ts"
      );
      snapshots.applySettingsSnapshot(settings.$settings.get());
    });
    await picker
      .getByRole("button", { name: "Show revisions for tour" })
      .click();
    await picker
      .getByRole("button", { name: "Open saved showfile tour" })
      .click();

    await expect(picker).toBeHidden();
    await expect(page.getByTestId("startup-splash")).toBeVisible();
    await expect(
      page.getByText("WebSocket disconnected before the command completed"),
    ).toHaveCount(0);
    await expect(page.locator("button[title='Menu']")).toHaveCount(0);
    expect(await readRevision()).toBe(initialRevision);

    await page.evaluate(() => {
      (
        window as Window & {
          __nightfallCompleteWorldSwap?: (
            confirmedShowfileName?: string,
          ) => void;
        }
      ).__nightfallCompleteWorldSwap?.("other");
    });

    await expect(page.getByTestId("startup-splash")).toBeVisible();
    await expect(page.locator("button[title='Menu']")).toHaveCount(0);

    await page.evaluate(() => {
      (
        window as Window & {
          __nightfallCompleteWorldSwap?: (
            confirmedShowfileName?: string,
          ) => void;
        }
      ).__nightfallCompleteWorldSwap?.();
    });
    await expect(page.getByTestId("startup-splash")).toBeHidden();
    await expect(page.locator("button[title='Menu']")).toBeVisible();
    expect(await readRevision()).toBe(initialRevision + 2);
    const panel = await page.locator("[data-panel-id]").first().elementHandle();
    expect(panel).not.toBeNull();
    const replayGeneration = await page.evaluate(async () => {
      const runtime = await import(/* @vite-ignore */ "/lib/engine-runtime.ts");
      const generation = runtime.resyncGeneration();
      (
        window as Window & {
          __nightfallCompleteWorldSwap?: () => void;
        }
      ).__nightfallCompleteWorldSwap?.();
      return generation;
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const runtime = await import(
            /* @vite-ignore */ "/lib/engine-runtime.ts"
          );
          return runtime.resyncGeneration();
        }),
      )
      .toBeGreaterThan(replayGeneration);
    await expect.poll(readRevision).toBe(initialRevision + 2);
    expect(await panel!.evaluate((element) => element.isConnected)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("confirmed-startup.png"),
    });
  });
}

/** Verifies a fresh backend session without a loaded showfile returns to startup selection. */
test("returns to startup picker when backend reconnects initialized", async ({
  page,
}) => {
  await disableE2eStartupAutoOpen(page);
  await installFakeWebsocketWorker(page);
  await routeShowfileDiscovery(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ showfiles: [] }),
    });
  });

  await page.goto("/");
  const menuButton = page.locator("button[title='Menu']");
  await expect(menuButton).toBeVisible();

  await page.evaluate(() => {
    const worker = (
      window as Window & {
        __nightfallFakeWorkers?: Array<{
          emitWorkerMessage: (data: unknown) => void;
        }>;
      }
    ).__nightfallFakeWorkers?.[0];
    worker?.emitWorkerMessage({
      type: "messageBatch",
      messages: [
        {
          data: { type: "AppState", data: "Initialized" },
          postedAtMs: performance.timeOrigin + performance.now(),
          deliveryMessageId: 100,
        },
        {
          data: { type: "ResyncComplete" },
          postedAtMs: performance.timeOrigin + performance.now(),
          deliveryMessageId: 101,
        },
      ],
    });
  });

  await expect(
    page.getByRole("dialog", { name: "Open Showfile" }),
  ).toBeVisible();
  await expect(menuButton).toBeHidden();
});
