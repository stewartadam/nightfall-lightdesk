// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "./playwright-fixtures";
import {
  openStartupShowfileIfPrompted,
  waitForDockviewApp,
} from "./showfile-startup";

const RUNS = Number(process.env.NIGHTFALL_LOAD_TIMING_RUNS ?? 4);
const SHOWFILE_NAME = "load-timing";
const SHOWFILE_FOLDER = `${SHOWFILE_NAME}.nightfall-show`;
/**
 * Showfile folder the probe opens. NIGHTFALL_LOAD_TIMING_SHOWFILE points at an
 * existing `<name>.nightfall-show` folder; otherwise the prepare step saves the
 * generated sample show here.
 */
const SEED_DIR =
  process.env.NIGHTFALL_LOAD_TIMING_SHOWFILE ??
  join(tmpdir(), "nightfall-startup-load-timing", SHOWFILE_FOLDER);
/** Quiet main-thread time required after content loads before a run ends. */
const QUIET_MS = 2_000;

type StartupTiming = {
  /** Milliseconds from the "Open saved showfile" click to each observed phase. */
  marks: Record<string, number>;
  /** Total main-thread time spent in long tasks after the click. */
  blockedMs: number;
  /** Fixtures in the loaded show. */
  fixtureCount: number;
};

declare global {
  interface Window {
    /** Startup load probe state installed before the app boots. */
    __startupTiming?: {
      clickAt?: number;
      marks: Record<string, number>;
      longTasks: { start: number; duration: number }[];
    };
  }
}

test.describe.configure({ mode: "serial" });

test.describe("prepare", () => {
  test.use({ sampleDataOnly: true, viewport: { width: 1920, height: 1080 } });

  /** Saves the sample show with extra data panels as the showfile the probe opens. */
  test("save startup timing showfile", async ({ page, backendSlot }) => {
    test.skip(
      process.env.NIGHTFALL_LOAD_TIMING !== "1",
      "Set NIGHTFALL_LOAD_TIMING=1 to run the startup load timing probe",
    );
    test.skip(
      process.env.NIGHTFALL_LOAD_TIMING_SHOWFILE !== undefined,
      "Using the showfile from NIGHTFALL_LOAD_TIMING_SHOWFILE",
    );
    await page.goto("/?startup:draftRecovery=false");
    await waitForDockviewApp(page);
    await page.evaluate(async (name) => {
      const api = (window as any).appStores.dockApi.get();
      const reference = api.panels[0];
      api.addPanel({
        id: "timing-fixtures",
        component: "FixtureGrid",
        title: "Fixtures",
        position: { referencePanel: reference.id, direction: "right" },
      });
      api.addPanel({
        id: "timing-layers",
        component: "LayerStack",
        title: "Layers",
        position: { referencePanel: "timing-fixtures", direction: "below" },
      });
      const actions = await import(
        /* @vite-ignore */ "/lib/showfile-actions.ts"
      );
      const runtime = await import(/* @vite-ignore */ "/lib/engine-runtime.ts");
      await runtime.engineRuntime.sendCommandAndAwait({
        module: "DeskCommand",
        command: actions.saveNamedShowfileCommand(name),
      });
    }, SHOWFILE_NAME);
    const saved = join(backendSlot.dataDir, SHOWFILE_FOLDER);
    await expect.poll(() => existsSync(saved)).toBe(true);
    await rm(SEED_DIR, { recursive: true, force: true });
    await mkdir(join(SEED_DIR, ".."), { recursive: true });
    await cp(saved, SEED_DIR, { recursive: true });
  });
});

/** Records click, dock, fixture and long-task timings from the first script on the page. */
async function installStartupProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "nightfall.e2eAutoOpenStartupShowfile",
      "false",
    );
    const state: NonNullable<Window["__startupTiming"]> = {
      marks: {},
      longTasks: [],
    };
    window.__startupTiming = state;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        state.longTasks.push({
          start: entry.startTime,
          duration: entry.duration,
        });
    }).observe({ type: "longtask", buffered: true });
    document.addEventListener(
      "click",
      (event) => {
        const button = (event.target as Element | null)?.closest(
          "[aria-label]",
        );
        const label = button?.getAttribute("aria-label") ?? "";
        if (state.clickAt === undefined && label.startsWith("Open saved"))
          state.clickAt = performance.now();
      },
      true,
    );
    /** Samples picker, shell, dock and fixture state once per frame after the click. */
    const tick = () => {
      if (state.clickAt !== undefined) {
        const elapsed = performance.now() - state.clickAt;
        const mark = (name: string, reached: boolean) => {
          if (reached && state.marks[name] === undefined)
            state.marks[name] = elapsed;
        };
        mark("pickerClosed", !document.querySelector('[role="dialog"]'));
        mark("shell", !!document.querySelector("button[title='Menu']"));
        const veiled = !!document.querySelector(
          '[data-testid="showfile-transition-veil"]:not(.opacity-0)',
        );
        const panels = document.querySelectorAll("[data-panel-id]").length;
        mark("dockVisible", panels > 0 && !veiled);
        const fixtures = (window as any).appStores?.fixtures?.get() ?? {};
        mark("fixturesLoaded", Object.keys(fixtures).length > 0);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

for (let run = 0; run < RUNS; run++) {
  test.describe(`measure ${run}`, () => {
    test.use({
      emptyStartupWorld: true,
      viewport: { width: 1920, height: 1080 },
    });

    /**
     * Measures opening a saved showfile from the startup picker until the dock
     * shows the show's panels and the main thread has gone quiet.
     *
     * Opt-in diagnostic: set NIGHTFALL_LOAD_TIMING=1. Marks are milliseconds
     * after the "Open saved showfile" click. `settled` is the latest of the
     * dock becoming visible, fixtures arriving, and the last long task ending.
     */
    test(`startup load timing run ${run}`, async ({
      page,
      backendSlot,
    }, testInfo) => {
      test.skip(
        process.env.NIGHTFALL_LOAD_TIMING !== "1",
        "Set NIGHTFALL_LOAD_TIMING=1 to run the startup load timing probe",
      );
      test.setTimeout(90_000);
      await cp(SEED_DIR, join(backendSlot.dataDir, SHOWFILE_FOLDER), {
        recursive: true,
      });
      await installStartupProbe(page);
      await page.goto("/?startup:draftRecovery=false");
      const picker = page.getByRole("dialog", { name: "Open Showfile" });
      await expect(picker).toBeVisible({ timeout: 30_000 });
      await expect(picker.getByText(SHOWFILE_NAME).first()).toBeVisible();
      await page.waitForTimeout(1_000);
      await openStartupShowfileIfPrompted(page, {
        showfileName: SHOWFILE_NAME,
      });
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const marks = window.__startupTiming?.marks ?? {};
              return (
                marks.dockVisible !== undefined &&
                marks.fixturesLoaded !== undefined
              );
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
      // Wait until no long task has run for QUIET_MS.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const tasks = window.__startupTiming?.longTasks ?? [];
              const last = tasks.at(-1);
              const lastEnd = last ? last.start + last.duration : 0;
              return performance.now() - lastEnd;
            }),
          { timeout: 30_000, intervals: [250] },
        )
        .toBeGreaterThan(QUIET_MS);
      const result: StartupTiming = await page.evaluate(() => {
        const state = window.__startupTiming!;
        const clickAt = state.clickAt ?? 0;
        const tasks = state.longTasks.filter((task) => task.start >= clickAt);
        const marks = { ...state.marks };
        const last = tasks.at(-1);
        if (last) marks.lastLongTaskEnd = last.start + last.duration - clickAt;
        marks.settled = Math.max(
          marks.dockVisible ?? 0,
          marks.fixturesLoaded ?? 0,
          marks.lastLongTaskEnd ?? 0,
        );
        for (const key of Object.keys(marks))
          marks[key] = Math.round(marks[key]);
        const fixtures = (window as any).appStores?.fixtures?.get() ?? {};
        return {
          marks,
          blockedMs: Math.round(
            tasks.reduce((sum, task) => sum + task.duration, 0),
          ),
          fixtureCount: Object.keys(fixtures).length,
        };
      });
      console.log(
        `run ${run}: ${JSON.stringify(result.marks)} blocked=${result.blockedMs}ms fixtures=${result.fixtureCount}`,
      );
      await page.screenshot({ path: testInfo.outputPath("settled.png") });
      await writeFile(
        testInfo.outputPath("startup-timing.json"),
        JSON.stringify(result, null, 2),
      );
      expect(result.fixtureCount).toBeGreaterThan(0);
    });
  });
}
