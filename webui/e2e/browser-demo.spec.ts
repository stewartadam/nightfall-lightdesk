// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads playback diagnostics independently of the visible shell controls. */
async function readDemoAudioState(page: Page) {
  return page.evaluate(() =>
    (window as any).appStores.browserDemoAudioState.get(),
  );
}

/** Install the production-like CSP and record bootstrap and backend transport. */
async function prepareEmbeddedPage(page: Page): Promise<{
  audioRequests: string[];
  backendRequests: string[];
  showfileRequests: string[];
}> {
  const audioRequests: string[] = [];
  const backendRequests: string[] = [];
  const showfileRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/api/") ||
      (request.resourceType() === "websocket" && url.pathname === "/ws")
    ) {
      backendRequests.push(request.url());
    }
    if (url.pathname.endsWith("/nightfall-demo.nightfall-show/showfile.json")) {
      showfileRequests.push(request.url());
    }
    if (request.resourceType() === "media") {
      audioRequests.push(request.url());
    }
  });
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const html = await response.text();
    const devScriptHashes =
      process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
        ? []
        : Array.from(
            html.matchAll(
              /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi,
            ),
            ([, script]) =>
              `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
          );
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "content-security-policy": `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' ${devScriptHashes.join(" ")}; worker-src 'self' blob:; connect-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:`,
      },
    });
  });
  return { audioRequests, backendRequests, showfileRequests };
}

/** Read the deterministic domain state and runtime capabilities exposed to the UI. */
async function readDemoState(page: Page) {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    const values = (storeName: string) =>
      Object.values(stores?.[storeName]?.get?.() ?? {});
    const timeline = values("timelines").find(
      (entry: any) => entry?.identifiers?.label === "Nightfall Demo",
    ) as any;
    return {
      capabilities: stores?.runtimeCapabilities?.get?.() ?? null,
      fixtureCount: values("fixtures").length,
      groupCount: values("groups").length,
      cueCount: values("cues").length,
      sequenceCount: values("sequences").length,
      clipCount: values("clips").length,
      fxCount: values("fx").length,
      timelineUid: timeline?.identifiers?.uid ?? null,
      markerCount: timeline?.markers?.length ?? 0,
      regionCount: timeline?.regions?.length ?? 0,
      audioPath: timeline?.audio_path ?? null,
      resyncComplete: stores?.resyncComplete?.() ?? false,
    };
  });
}

/** Open a playback workspace independent of the bundled showfile's saved panel layout. */
async function openDemoTimeline(
  page: Page,
  timelineUid: string,
): Promise<void> {
  await waitForDockviewApp(page);
  await page.evaluate((uid) => {
    const api = (window as any).appStores?.dockApi?.get?.();
    if (!api) throw new Error("Dockview was unavailable");
    api.clear();
    api.addPanel({
      id: `browser-demo-timeline-${uid}`,
      component: "Timeline",
      title: "Nightfall Demo Timeline",
      params: { initialTimelineUid: uid },
    });
  }, timelineUid);
  await expect(
    page.locator(
      `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
    ),
  ).toBeVisible();
}

/** Open the clip list beside the timeline and return the seeded FX clip UID. */
async function openDemoClips(page: Page, timelineUid: string): Promise<string> {
  const clipUid = await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const entry = Object.values(stores.clips.get()).find(
      (candidate: any) => candidate[0].identifiers.label === "Nightfall Wave",
    ) as any;
    if (!entry) throw new Error("Seeded Nightfall Wave clip was unavailable");
    stores.dockApi.get().addPanel({
      id: "browser-demo-clips",
      component: "ClipList",
      title: "Clips",
      params: { initialPanelId: "browser-demo-clips" },
      position: {
        referencePanel: `browser-demo-timeline-${uid}`,
        direction: "right",
      },
    });
    return entry[0].identifiers.uid;
  }, timelineUid);
  await expect(
    page.locator(
      '[data-panel-kind="clips"][data-panel-id="browser-demo-clips"]',
    ),
  ).toBeVisible();
  return clipUid;
}

/** Return the current linked timecode position for the seeded timeline. */
async function timelinePositionMs(page: Page, timelineUid: string) {
  return page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    const state = stores.timecodes.get()[timeline.timecode_uid]?.[1];
    const duration = state?.current_time ?? { secs: 0, nanos: 0 };
    return duration.secs * 1_000 + duration.nanos / 1_000_000;
  }, timelineUid);
}

/** Submit a programmer expression through the visible product command bar. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate((submittedCommand) => {
        const entries =
          (window as any).appStores?.consoleScrollback?.get?.() ?? [];
        const matches = entries.filter(
          (entry: any) => entry.command === submittedCommand,
        );
        const last = matches[matches.length - 1];
        return last
          ? { errorMessage: last.errorMessage, status: last.status }
          : null;
      }, command),
    )
    .toEqual({ status: "success" });
}

/** Return the stable UUID for the first seeded demo fixture. */
async function fixtureOneUid(page: Page): Promise<string> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    const fixture = Object.values(stores.fixtures.get()).find(
      (candidate: any) => candidate.identifiers.id === 1,
    ) as any;
    if (!fixture) throw new Error("Demo fixture 1 was unavailable");
    return fixture.identifiers.uid;
  });
}

/** Report whether the browser can create a WebGL context for the visualizer. */
async function supportsVisualizerWebGl(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  });
}

/** Activate the normal visualizer panel and wait for the seeded rig to render. */
async function activateVisualizer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    let panel = api.getPanel("panel-Visualizer");
    if (!panel) {
      panel = api.addPanel({
        id: "panel-Visualizer",
        component: "Visualizer",
        title: "3D Visualizer",
        params: {},
      });
    }
    panel.api.setActive();
    panel.focus();
  });
  const panel = page.locator('[data-panel-id="panel-Visualizer"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator("canvas").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as any).visualizerApis?.["panel-Visualizer"]),
      ),
    )
    .toBe(true);
}

/** Read representative programmer output values for fixture one. */
async function readProgrammerOutput(page: Page, fixtureUid: string) {
  return page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const row = stores.parameters.get().get(uid);
    return {
      intensity: Number(row?.raw?.VirtualIntensity ?? 0),
      red: Number(row?.raw?.Red ?? 0),
      green: Number(row?.raw?.Green ?? 0),
      blue: Number(row?.raw?.Blue ?? 0),
      pan: Number(row?.raw?.Pan ?? 0),
      tilt: Number(row?.raw?.Tilt ?? 0),
    };
  }, fixtureUid);
}

/** Store a visibly renamed sample cue through the correlated cue command lifecycle. */
async function renameDemoCue(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const stores = (window as any).appStores;
    const cue = Object.values(stores.cues.get()).find(
      (candidate: any) => candidate.identifiers.label === "Midnight Blue",
    ) as any;
    if (!cue) throw new Error("Seeded Midnight Blue cue was unavailable");
    const result = await stores.sendAndAwait({
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: {
          ...cue,
          identifiers: { ...cue.identifiers, label: "Edited Midnight Blue" },
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(`Unable to edit demo cue: ${JSON.stringify(result)}`);
    }
    return cue.identifiers.uid;
  });
}

/** Seek the timeline's linked timecode through its normal command module. */
async function seekTimeline(
  page: Page,
  timelineUid: string,
  positionMs: number,
): Promise<void> {
  await page.evaluate(
    async ({ uid, nextPositionMs }) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      const timecode = stores.timecodes.get()[timeline.timecode_uid]?.[0];
      if (!timecode) throw new Error("Demo timeline timecode was unavailable");
      const result = await stores.sendAndAwait({
        module: "TimecodeCommand",
        command: {
          type: "SeekTimecode",
          data: {
            id: timecode.identifiers.id,
            position: {
              secs: Math.floor(nextPositionMs / 1_000),
              nanos: (nextPositionMs % 1_000) * 1_000_000,
            },
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `Unable to seek demo timeline: ${JSON.stringify(result)}`,
        );
      }
    },
    { uid: timelineUid, nextPositionMs: positionMs },
  );
  await expect
    .poll(() => timelinePositionMs(page, timelineUid))
    .toBeCloseTo(positionMs, -1);
}

/** Verify the full product UI edits and plays its sample without native services. */
test("embedded demo edits and plays the sample without backend traffic", async ({
  baseURL,
  browserName,
  page,
}, testInfo) => {
  if (
    browserName === "chromium" &&
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE !== "preview"
  ) {
    // Routed document responses need loopback access for Vite's HMR WebSocket.
    await page
      .context()
      .grantPermissions(["local-network-access"], { origin: baseURL });
  }
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) =>
    pageErrors.push(error.stack ?? error.message),
  );
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error") {
      consoleErrors.push(text);
    }
  });
  const { audioRequests, backendRequests, showfileRequests } =
    await prepareEmbeddedPage(page);
  const demoBasePath =
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
      ? "/demo/app/?startup:draftRecovery=false&e2e=1"
      : "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1";
  const demoPath = `${demoBasePath}${
    browserName === "firefox"
      ? "&visualizer:offscreenCanvas=false&visualizer:defaultPanel=false"
      : ""
  }`;
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.currentShowfileName", "local-show");
  });
  await page.goto(demoPath);

  await expect(
    page
      .getByRole("region", { name: "Application status bar" })
      .getByTestId("browser-demo-banner"),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Global" })).toContainText(
    "nightfall demo",
  );
  await expect(page.getByTestId("browser-demo-audio-status")).toHaveCount(0);
  await expect(page.getByTestId("status-build-name")).toHaveCount(0);
  await expect(page.getByTestId("status-showfile-name")).toHaveText(
    "nightfall-demo",
  );
  await expect(page.getByTestId("browser-demo-banner")).toHaveText(
    "Reset demo",
  );
  await expect
    .poll(async () => ({
      ...(await readDemoState(page)),
      consoleErrors,
      pageErrors,
    }))
    .toMatchObject({
      capabilities: {
        runtime_mode: "EmbeddedDemo",
        persistence: "Unavailable",
        fx_modules: "Unavailable",
        timeline_audio: "BundledBrowser",
        network_dmx_output: false,
        usb_dmx_output: false,
      },
      fixtureCount: 6,
      groupCount: 1,
      cueCount: 2,
      sequenceCount: 1,
      clipCount: 2,
      fxCount: 1,
      markerCount: 2,
      regionCount: 1,
      consoleErrors: [],
      pageErrors: [],
    });
  const initialState = await readDemoState(page);
  expect(initialState.timelineUid).toBeTruthy();
  expect(initialState.audioPath).toBe(
    `timeline-audio/${initialState.timelineUid}/nightfall-demo-click.wav`,
  );
  const loadedShowfileUrl = showfileRequests[0];
  if (!initialState.audioPath || !loadedShowfileUrl) {
    throw new Error("Embedded showfile audio metadata was unavailable");
  }
  const expectedAudioUrl = new URL(initialState.audioPath, loadedShowfileUrl)
    .href;

  const fixtureUid = await fixtureOneUid(page);
  const visualizerSupported =
    browserName !== "firefox" && (await supportsVisualizerWebGl(page));
  if (visualizerSupported) {
    await activateVisualizer(page);
  } else {
    testInfo.annotations.push({
      type: "browser-capability",
      description:
        browserName === "firefox"
          ? "Headless Firefox cannot reliably create the Babylon WebGL context; Chromium covers 3D visualizer activation"
          : "WebGL unavailable; skipped 3D visualizer activation",
    });
  }
  await submitCommand(
    page,
    "fix 1>6 @ 65 red @ 80 green @ 10 blue @ 30 pan @ 20 tilt @ 70",
  );
  await expect
    .poll(async () => {
      const output = await readProgrammerOutput(page, fixtureUid);
      return (
        output.intensity > 0 &&
        output.red > output.blue &&
        output.blue > output.green &&
        output.tilt > output.pan
      );
    })
    .toBe(true);
  const programmerOutput = await readProgrammerOutput(page, fixtureUid);
  expect(programmerOutput.intensity).toBeGreaterThan(0);
  expect(programmerOutput.red).toBeGreaterThan(programmerOutput.blue);
  expect(programmerOutput.blue).toBeGreaterThan(programmerOutput.green);
  expect(programmerOutput.tilt).toBeGreaterThan(programmerOutput.pan);
  await page.waitForTimeout(250);
  expect(await readProgrammerOutput(page, fixtureUid)).toEqual(
    programmerOutput,
  );
  if (visualizerSupported) {
    await page
      .locator('[data-panel-id="panel-Visualizer"]')
      .screenshot({ path: testInfo.outputPath("browser-demo-visualizer.png") });
  }

  const editedCueUid = await renameDemoCue(page);
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.cues.get()[uid]?.identifiers?.label,
        editedCueUid,
      ),
    )
    .toBe("Edited Midnight Blue");

  await openDemoTimeline(page, initialState.timelineUid);
  const fxClipUid = await openDemoClips(page, initialState.timelineUid);
  const fxActiveIndicator = page
    .locator('[data-panel-kind="clips"][data-panel-id="browser-demo-clips"]')
    .locator(`[data-clip-active-indicator="${fxClipUid}"]`);
  await expect(fxActiveIndicator).toHaveCount(0);

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${initialState.timelineUid}"]`,
  );
  const waveform = surface.locator(".waveform-container");
  await expect(waveform).toBeVisible();
  await expect
    .poll(async () => ({
      consoleErrors,
      state: await waveform.getAttribute("data-waveform-state"),
    }))
    .toEqual({ consoleErrors: [], state: "decoded" });

  await surface.getByRole("button", { name: "Drop marker" }).click();
  await expect
    .poll(async () => (await readDemoState(page)).markerCount)
    .toBe(3);

  await surface.getByRole("button", { name: "Play timeline" }).click();
  await expect
    .poll(() => readDemoAudioState(page))
    .toMatchObject({ status: "playing" });
  expect(audioRequests).toContain(expectedAudioUrl);
  await expect
    .poll(() => timelinePositionMs(page, initialState.timelineUid))
    .toBeGreaterThan(250);

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const rows = Array.from(
          (window as any).appStores.parameters.get().values(),
        ) as any[];
        return rows.filter((row) => Number(row.raw?.VirtualIntensity ?? 0) > 0)
          .length;
      });
    })
    .toBeGreaterThan(0);

  await surface.getByRole("button", { name: "Pause timeline" }).click();
  await expect
    .poll(() => readDemoAudioState(page))
    .toMatchObject({ status: "paused" });

  await seekTimeline(page, initialState.timelineUid, 2_000);
  await expect
    .poll(async () => (await readDemoAudioState(page)).positionMs)
    .toBeGreaterThan(1_900);

  await surface.getByRole("button", { name: "Toggle loop range" }).click();
  await expect(
    surface.locator('[data-timeline-loop-overlay="true"]'),
  ).toBeVisible();
  await seekTimeline(page, initialState.timelineUid, 3_400);
  await surface.getByRole("button", { name: "Play timeline" }).click();
  await expect(fxActiveIndicator).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("browser-demo-fx-clip-active.png"),
    fullPage: true,
  });
  await expect
    .poll(() => timelinePositionMs(page, initialState.timelineUid), {
      timeout: 3_000,
    })
    .toBeLessThan(2_000);
  await surface.getByRole("button", { name: "Stop timeline" }).click();
  await expect
    .poll(() => timelinePositionMs(page, initialState.timelineUid))
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() => readDemoAudioState(page))
    .toMatchObject({ status: "unloaded" });
  await expect(fxActiveIndicator).toHaveCount(0);

  await surface.getByRole("button", { name: "Play timeline" }).click();
  await expect
    .poll(() => readDemoAudioState(page))
    .toMatchObject({ status: "playing" });
  await expect
    .poll(() => timelinePositionMs(page, initialState.timelineUid))
    .toBeGreaterThan(250);
  await surface.getByRole("button", { name: "Stop timeline" }).click();
  await expect
    .poll(() => readDemoAudioState(page))
    .toMatchObject({ status: "unloaded" });

  const runtimeInfo = await page.evaluate(() =>
    (window as any).appStores.browserDemoRuntimeInfo.get(),
  );
  await writeFile(
    testInfo.outputPath("browser-demo-runtime-info.json"),
    JSON.stringify(runtimeInfo, null, 2),
  );
  await page.screenshot({
    path: testInfo.outputPath("browser-demo-product-flow.png"),
    fullPage: true,
  });
  expect(showfileRequests).toHaveLength(1);

  await page.getByTestId("browser-demo-reset").click();
  await expect
    .poll(async () => (await readDemoState(page)).markerCount)
    .toBe(2);
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.cues.get()[uid]?.identifiers?.label,
        editedCueUid,
      ),
    )
    .toBe("Midnight Blue");
  await expect
    .poll(() => readDemoAudioState(page))
    .toMatchObject({ status: "unloaded" });

  await expect(page.getByTestId("status-showfile-name")).toHaveText(
    "nightfall-demo",
  );
  expect(
    await page.evaluate(() =>
      localStorage.getItem("nightfall.currentShowfileName"),
    ),
  ).toBe("local-show");
  expect(backendRequests).toEqual([]);
  expect(showfileRequests).toHaveLength(2);
  expect([...new Set(audioRequests)]).toEqual([expectedAudioUrl]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

/** Verify the tracked show and generated audio support real timeline playback. */
test("embedded fixture decodes and plays generated timeline audio", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    (window as any).demoAudioSeekCount = 0;
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "currentTime",
    )!;
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      ...descriptor,
      /** Count explicit media seeks while preserving real browser playback. */
      set(value: number) {
        (window as any).demoAudioSeekCount += 1;
        descriptor.set!.call(this, value);
      },
    });
  });
  const basePath =
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
      ? "/demo/app/"
      : "/";
  await page.goto(
    `${basePath}?engine=embedded-demo&startup:draftRecovery=false&e2e=1&visualizer:defaultPanel=false`,
  );
  await expect
    .poll(async () => (await readDemoState(page)).timelineUid)
    .toBeTruthy();
  const { timelineUid } = await readDemoState(page);
  await openDemoTimeline(page, timelineUid);
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface.locator(".waveform-container")).toHaveAttribute(
    "data-waveform-state",
    "decoded",
  );
  try {
    await surface.getByRole("button", { name: "Play timeline" }).click();
    await expect
      .poll(() => readDemoAudioState(page))
      .toMatchObject({ status: "playing" });
    await expect
      .poll(() => timelinePositionMs(page, timelineUid))
      .toBeGreaterThan(100);
    const seekCount = await page.evaluate(
      () => (window as any).demoAudioSeekCount,
    );
    await page.waitForTimeout(750);
    expect(await page.evaluate(() => (window as any).demoAudioSeekCount)).toBe(
      seekCount,
    );
    await expect
      .poll(async () => (await readDemoAudioState(page)).positionMs)
      .toBeGreaterThan(500);
    await page.evaluate(async (uid) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      const result = await stores.sendAndAwait({
        module: "TimelineCommand",
        command: {
          type: "StoreTimeline",
          data: {
            ...timeline,
            timecode_start: { secs: 0, nanos: 500_000_000 },
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `Unable to edit timeline start: ${JSON.stringify(result)}`,
        );
      }
    }, timelineUid);
    await expect
      .poll(() => page.evaluate(() => (window as any).demoAudioSeekCount), {
        timeout: 1_000,
      })
      .toBeGreaterThan(seekCount);
    await surface.screenshot({
      path: testInfo.outputPath("generated-audio-playback.png"),
    });
  } finally {
    await surface.getByRole("button", { name: "Stop timeline" }).click();
  }
  await expect
    .poll(() => readDemoAudioState(page))
    .toMatchObject({ status: "unloaded" });
});

/** Verifies demo identity, toolbar placement, and reset without changing the local showfile selection. */
test("demo shell keeps runtime information in the bottom toolbar", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.currentShowfileName", "local-show");
  });
  const path =
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview"
      ? "/demo/app/?e2e=1"
      : "/?engine=embedded-demo&e2e=1";
  await page.goto(path);
  await waitForDockviewApp(page);
  const bar = page.getByRole("region", { name: "Application status bar" });
  const banner = bar.getByTestId("browser-demo-banner");
  const header = page.getByRole("navigation", { name: "Global" });
  await expect(banner).toHaveText("Reset demo");
  await expect(header).toContainText("nightfall demo");
  await expect(page.getByTestId("browser-demo-audio-status")).toHaveCount(0);
  await expect(page.getByTestId("status-build-name")).toHaveCount(0);
  await expect(bar.getByTestId("status-showfile-name")).toHaveText(
    "nightfall-demo",
  );
  const reset = bar.getByTestId("browser-demo-reset");
  await expect(reset).toHaveCSS("font-size", "12px");
  await expect(reset).toHaveCSS("height", "20px");
  const barBox = (await bar.boundingBox())!;
  const bannerBox = (await banner.boundingBox())!;
  expect(bannerBox.y).toBeGreaterThanOrEqual(barBox.y);
  expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(
    barBox.y + barBox.height,
  );
  expect((await header.boundingBox())!.y).toBeLessThan(20);
  const initialSession = (await readDemoAudioState(page)).session;
  await bar.getByTestId("browser-demo-reset").click();
  await expect
    .poll(async () => (await readDemoAudioState(page)).session)
    .toBeGreaterThan(initialSession);
  await expect
    .poll(async () => (await readDemoState(page)).fixtureCount)
    .toBe(6);
  await expect(bar.getByTestId("status-showfile-name")).toHaveText(
    "nightfall-demo",
  );
  expect(
    await page.evaluate(() =>
      localStorage.getItem("nightfall.currentShowfileName"),
    ),
  ).toBe("local-show");
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Open I/O Transports");
  await page.keyboard.press("Enter");
  const transports = page.locator('[data-component="IoTransportsPanel"]');
  await expect(transports).toBeVisible();
  for (const name of [
    "Enable network input",
    "Enable network output",
    "Enable USB output",
  ]) {
    const toggle = transports.getByRole("switch", { name, exact: true });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
  }
  await page.screenshot({
    path: testInfo.outputPath("demo-toolbar.png"),
    fullPage: true,
  });
});
