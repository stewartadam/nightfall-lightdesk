// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFile } from "node:fs/promises";
import { decode } from "cborg";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true, viewport: { width: 1600, height: 1000 } });

/** Copies of the sample rig's fixture mix to patch; 20 copies make 1,120 fixtures. */
const SCALE = Number(process.env.NIGHTFALL_LARGE_SHOW_SCALE ?? 20);
/** First fixture ID of the generated rig, clear of the sample show's own IDs. */
const BASE_FIXTURE_ID = 10_001;
/** First console universe of the generated rig, clear of the sample show's patch. */
const BASE_UNIVERSE = 101;
/** How long each measured phase runs. */
const PHASE_MS = 6_000;

/** One copy of the sample show's rig: built-in model, mode, DMX footprint and count. */
const RIG_UNIT = [
  { model: "RGBPixelTape 120ch RGB", mode: "RGB", channels: 120, count: 32 },
  { model: "Moving Head Spot 16ch", mode: "Spot", channels: 16, count: 6 },
  {
    model: "12-segment Rotating Wash Beam",
    mode: "Beam",
    channels: 194,
    count: 6,
  },
  { model: "RGB Strobe Bar 168ch", mode: "Strobe", channels: 168, count: 6 },
  { model: "Strobe Matrix 308ch", mode: "Strobe", channels: 308, count: 2 },
  { model: "Strobe Matrix 312ch", mode: "Strobe", channels: 312, count: 4 },
];

/** Fixture group of the generated rig, with the IDs and universes it occupies. */
interface RigGroup {
  model: string;
  mode: string;
  firstId: number;
  lastId: number;
  firstUniverse: number;
  lastUniverse: number;
  fixturesPerUniverse: number;
}

/** Lays the scaled rig out as contiguous fixture ID and console universe ranges per model. */
function planRig(scale: number): RigGroup[] {
  const groups: RigGroup[] = [];
  let nextId = BASE_FIXTURE_ID;
  let nextUniverse = BASE_UNIVERSE;
  for (const { model, mode, channels, count } of RIG_UNIT) {
    const total = count * scale;
    const fixturesPerUniverse = Math.floor(512 / channels);
    const universes = Math.ceil(total / fixturesPerUniverse);
    groups.push({
      model,
      mode,
      firstId: nextId,
      lastId: nextId + total - 1,
      firstUniverse: nextUniverse,
      lastUniverse: nextUniverse + universes - 1,
      fixturesPerUniverse,
    });
    nextId += total;
    nextUniverse += universes;
  }
  return groups;
}

/**
 * Creates, patches and places the generated rig through the same commands the patch wizard
 * sends, then saves it as a named showfile.
 */
async function generateShowfile(
  page: Page,
  groups: RigGroup[],
  name: string,
): Promise<void> {
  await page.evaluate(
    async ({ groups, name }) => {
      const runtime = window.__nightfallTest.runtime;
      const send = async (module: string, command: unknown) => {
        const result = await runtime.engineRuntime.sendCommandAndAwait({
          module,
          command,
        } as any);
        if (result?.outcome?.type === "Failed") {
          throw new Error(
            `${module} failed: ${JSON.stringify(result.outcome.data)}`,
          );
        }
      };
      const columns = 40;
      let index = 0;
      for (const group of groups) {
        const ids: number[] = [];
        for (let id = group.firstId; id <= group.lastId; id++) ids.push(id);
        await send("FixtureLibraryCommand", {
          type: "CreateFixturesFromLibrary",
          data: {
            make: "Generic",
            model: group.model,
            mode: group.mode,
            fixtures: ids.map((id) => ({ id })),
          },
        });
        // One binding per universe: a binding spanning a universe range places one fixture
        // per universe, so packing several fixtures into a universe needs its own binding.
        for (
          let chunk = 0;
          chunk * group.fixturesPerUniverse < ids.length;
          chunk++
        ) {
          const universe = group.firstUniverse + chunk;
          await send("FixtureCommand", {
            type: "PatchBinding",
            data: {
              source: {
                type: "Fixture",
                data: {
                  ids: ids.slice(
                    chunk * group.fixturesPerUniverse,
                    (chunk + 1) * group.fixturesPerUniverse,
                  ),
                },
              },
              target: {
                type: "Console",
                data: {
                  universe: { start: universe, end: universe },
                  address: 1,
                },
              },
              priority: 0,
              clone: false,
            },
          });
        }
        await send("FixtureCommand", {
          type: "UpdateFixturePlacements",
          data: {
            updates: ids.map((id) => {
              const slot = index++;
              return {
                id,
                position: {
                  type: "All",
                  data: {
                    x: ((slot % columns) - columns / 2) * 0.5,
                    y: 0.05 + Math.floor(slot / (columns * 20)) * 2,
                    z: -4 - (Math.floor(slot / columns) % 20) * 0.5,
                  },
                },
              };
            }),
          },
        });
      }
      const actions = (await window.__nightfallHarness.load("app"))
        .showfileActions;
      await send("DeskCommand", actions.saveNamedShowfileCommand(name));
    },
    { groups, name },
  );
}

/** Load phases of a showfile, in milliseconds from the load request. */
interface LoadTiming {
  resyncMs?: number;
  revealedMs?: number;
  lastLongTaskEndMs?: number;
  blockedMs: number;
}

/**
 * Loads a named showfile and times when the post-load resync completed, when the loading veil
 * revealed the dock, and how long the main thread was blocked by long tasks while it settled.
 */
async function loadShowfile(page: Page, name: string): Promise<LoadTiming> {
  return page.evaluate(async (name) => {
    const runtime = window.__nightfallTest.runtime;
    const actions = (await window.__nightfallHarness.load("app"))
      .showfileActions;
    const longTasks: { start: number; duration: number }[] = [];
    const t0 = performance.now();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        longTasks.push({
          start: entry.startTime - t0,
          duration: entry.duration,
        });
    });
    observer.observe({ type: "longtask", buffered: false });
    const generation = runtime.resyncGeneration();
    const timing: { resyncMs?: number; revealedMs?: number } = {};
    let veiled = false;
    actions.loadShowfileName(name);
    await new Promise<void>((resolve) => {
      /** Samples resync and veil state once per frame until the load has settled. */
      const tick = () => {
        const elapsed = performance.now() - t0;
        if (
          timing.resyncMs === undefined &&
          runtime.resyncComplete() &&
          runtime.resyncGeneration() > generation
        )
          timing.resyncMs = Math.round(elapsed);
        const veil = document.querySelector(
          '[data-testid="showfile-transition-veil"]:not(.opacity-0)',
        );
        if (veil) veiled = true;
        if (veiled && !veil && timing.revealedMs === undefined)
          timing.revealedMs = Math.round(elapsed);
        if (
          (timing.resyncMs !== undefined &&
            elapsed > timing.resyncMs + 5_000) ||
          elapsed > 60_000
        ) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    observer.disconnect();
    const last = longTasks.at(-1);
    return {
      ...timing,
      lastLongTaskEndMs: last
        ? Math.round(last.start + last.duration)
        : undefined,
      blockedMs: Math.round(longTasks.reduce((sum, t) => sum + t.duration, 0)),
    };
  }, name);
}

/** Bytes and message counts one websocket client received, per message type. */
type TrafficCounts = Record<string, { messages: number; bytes: number }>;

/**
 * A second websocket client on the test's backend that only counts what it receives, so the
 * numbers describe what one more connected device costs, independent of the page under test.
 */
class TrafficObserver {
  private counts: TrafficCounts = {};
  private socket: WebSocket | null = null;

  /** Connects to the backend and asks for a full resync, so parameter frames start flowing. */
  async connect(backendPort: number): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${backendPort}/ws`);
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("observer")), {
        once: true,
      });
    });
    socket.addEventListener("message", (event) => this.record(event.data));
    socket.send(
      JSON.stringify({
        command_id: crypto.randomUUID(),
        module: "EngineCommand",
        command: { type: "ResyncState" },
      }),
    );
    this.socket = socket;
  }

  /**
   * Counts one frame under its message type; parameter state frames are split into keyframes
   * and deltas by their discriminator byte.
   */
  private record(data: unknown): void {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 2) return;
    const bytes = new Uint8Array(data);
    let type = "unknown";
    try {
      const message = decode(bytes.subarray(1)) as { type?: string };
      type = message?.type ?? "unknown";
    } catch {
      type = "undecodable";
    }
    if (type === "ParameterState")
      type =
        bytes[0] === 2 ? "ParameterState.delta" : "ParameterState.keyframe";
    this.counts[type] ??= { messages: 0, bytes: 0 };
    this.counts[type].messages++;
    this.counts[type].bytes += bytes.byteLength;
  }

  /** Returns the counts gathered since the last call and starts a new window. */
  take(): TrafficCounts {
    const counts = this.counts;
    this.counts = {};
    return counts;
  }

  /** Disconnects from the backend. */
  close(): void {
    this.socket?.close();
  }
}

/** Main-thread scopes that handle each parameter state delivery. */
const SCOPES = [
  "websocket-main.parameter-state.unpack",
  "websocket-main.parameter-state.immediate-params",
  "websocket-main.parameter-state.process",
  "websocket-main.parameter-state.store-set",
  "visualizer.dmx-snapshot.rebuild",
];

/**
 * Starts recording parameter scope measures and long tasks into page globals, alongside the
 * app's own collector, which clears measures from the performance timeline as it reads them.
 */
async function observePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = {
      measures: {} as Record<string, number[]>,
      longTasks: [] as number[],
    };
    (window as any).__largeShowPerf = state;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntriesByType("measure")) {
        state.measures[entry.name] ??= [];
        state.measures[entry.name].push(entry.duration);
      }
    }).observe({ type: "measure" });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        state.longTasks.push(entry.duration);
    }).observe({ type: "longtask" });
  });
}

/**
 * Summarizes and clears the page measurements since the last call: per scope count, median,
 * p95 and total ms, long task total, and the engine's reported frame rate.
 */
async function takePageMetrics(page: Page) {
  return page.evaluate((scopes) => {
    const state = (window as any).__largeShowPerf;
    const summary: Record<string, Record<string, number>> = {};
    for (const scope of scopes) {
      const durations = [...(state.measures[`nightfall:${scope}`] ?? [])].sort(
        (a: number, b: number) => a - b,
      );
      const at = (q: number) =>
        durations[
          Math.min(durations.length - 1, Math.floor(durations.length * q))
        ] ?? 0;
      summary[scope] = {
        count: durations.length,
        medianMs: Number(at(0.5).toFixed(3)),
        p95Ms: Number(at(0.95).toFixed(3)),
        totalMs: Number(
          durations.reduce((sum: number, d: number) => sum + d, 0).toFixed(1),
        ),
      };
    }
    const longTaskMs = Math.round(
      state.longTasks.reduce((sum: number, d: number) => sum + d, 0),
    );
    state.measures = {};
    state.longTasks = [];
    return {
      scopes: summary,
      longTaskMs,
      engineFps: (window as any).appStores.engineMetrics.get()?.fps ?? null,
    };
  }, SCOPES);
}

/** Submits a command through the header command line. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator("#header-cmdline");
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/**
 * Generates a showfile with a scaled-up copy of the sample rig, then measures on it: how long
 * the showfile takes to load, and, with the 3D visualizer open, the websocket traffic one client
 * receives, the engine frame rate and the main thread's parameter state handling while idle,
 * while 1% of fixtures change and while every fixture changes.
 *
 * Opt-in with NIGHTFALL_LARGE_SHOW_PERF=1 since timings depend on the machine; set
 * NIGHTFALL_LARGE_SHOW_SCALE to change the rig size. The summary is printed and attached.
 */
test("measures performance on a generated large showfile", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.skip(
    process.env.NIGHTFALL_LARGE_SHOW_PERF !== "1",
    "Set NIGHTFALL_LARGE_SHOW_PERF=1 to run the large show performance probe",
  );
  testInfo.setTimeout(600_000);
  const groups = planRig(SCALE);
  const fixtureCount = groups.at(-1)!.lastId - BASE_FIXTURE_ID + 1;
  const lastId = groups.at(-1)!.lastId;
  const universes = groups.at(-1)!.lastUniverse - BASE_UNIVERSE + 1;
  const showName = `large-show-${fixtureCount}`;

  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const generateStart = Date.now();
  await generateShowfile(page, groups, showName);
  const generateMs = Date.now() - generateStart;

  const load = await loadShowfile(page, showName);
  await waitForDockviewApp(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => Object.keys((window as any).appStores.fixtures.get()).length,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(fixtureCount);

  await page
    .getByRole("tab", { name: "3D Visualizer", exact: true })
    .first()
    .click();
  await expect(
    page.locator('[data-panel-id="panel-Visualizer"] canvas').first(),
  ).toBeVisible();
  await observePage(page);
  const visualizerStart = Date.now();
  let visualizerReadyMs: number | null = null;
  try {
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as any).__largeShowPerf.measures[
                "nightfall:visualizer.dmx-snapshot.rebuild"
              ]?.length ?? 0,
          ),
        { timeout: 120_000, intervals: [500] },
      )
      .toBeGreaterThan(0);
    visualizerReadyMs = Date.now() - visualizerStart;
  } catch {
    // Recorded as null: the visualizer never converted parameter output for this rig.
  }

  const observer = new TrafficObserver();
  await observer.connect(backendSlot.backendPort);
  await page.waitForTimeout(3_000);

  /** Runs one phase for PHASE_MS while `drive` issues commands, and collects its metrics. */
  const measure = async (drive: (deadline: number) => Promise<void>) => {
    observer.take();
    await takePageMetrics(page);
    const start = Date.now();
    await drive(start + PHASE_MS);
    const remaining = start + PHASE_MS - Date.now();
    if (remaining > 0) await page.waitForTimeout(remaining);
    const seconds = (Date.now() - start) / 1000;
    const traffic = observer.take();
    const totalBytes = Object.values(traffic).reduce(
      (sum, t) => sum + t.bytes,
      0,
    );
    return {
      seconds: Number(seconds.toFixed(2)),
      kbPerSecond: Number((totalBytes / 1024 / seconds).toFixed(1)),
      traffic,
      ...(await takePageMetrics(page)),
    };
  };

  /** Repeatedly sets intensity on a fixture range until the deadline. */
  const changeIntensity = (count: number) => async (deadline: number) => {
    for (let step = 1; Date.now() < deadline - 300; step++) {
      await submitCommand(
        page,
        `fix ${BASE_FIXTURE_ID}>${BASE_FIXTURE_ID + count - 1} int @ ${(step * 37) % 100}`,
      );
      await page.waitForTimeout(150);
    }
  };

  const idle = await measure(async () => {});
  const onePercent = await measure(
    changeIntensity(Math.max(1, Math.round(fixtureCount / 100))),
  );
  const everyFixture = await measure(changeIntensity(fixtureCount));
  observer.close();

  const result = {
    fixtureCount,
    lastId,
    universes,
    generateMs,
    load,
    visualizerReadyMs,
    idle,
    onePercent,
    everyFixture,
  };
  await page.screenshot({ path: testInfo.outputPath("large-show.png") });
  // Debug
  console.log(`large-show-performance ${JSON.stringify(result)}`);
  await writeFile(
    testInfo.outputPath("large-show-performance.json"),
    JSON.stringify(result, null, 2),
  );
  await testInfo.attach("large-show-performance.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(
    onePercent.traffic["ParameterState.delta"]?.messages ?? 0,
  ).toBeGreaterThan(0);
});
