// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { decode } from "cborg";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true });
test.setTimeout(120_000);

/** Exercises real OS audio discovery during continuous red/blue sequence playback. */
test("captures live color output cadence during audio discovery", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.skip(
    process.env.NIGHTFALL_AUDIO_DISCOVERY_PERF !== "1",
    "Opt-in hardware timing check",
  );
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys((window as any).appStores?.sequences?.get?.() ?? {})
            .length,
      ),
    )
    .toBeGreaterThan(0);

  const fixtureUid = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    /** Rejects setup and playback commands that the engine did not accept. */
    async function send(module: string, type: string, data: unknown) {
      const result = await stores.sendAndAwait({
        module,
        command: { type, data },
      });
      if (result.outcome.type !== "Succeeded")
        throw new Error(JSON.stringify(result));
    }
    const sequence: any = structuredClone(
      Object.values(stores.sequences.get()).find(
        (item: any) => item.identifiers.id === 21,
      ),
    );
    sequence.wrap = true;
    for (const [index, uid] of sequence.steps.entries()) {
      const cue = structuredClone(stores.cues.get()[uid]);
      cue.trigger = { type: "FollowPrevious" };
      cue.transitions = {
        delay_in: { type: "Fixed", data: { secs: 0, nanos: 0 } },
        delay_out: { type: "Fixed", data: { secs: 0, nanos: 0 } },
        fade_in: { type: "Fixed", data: { secs: 0, nanos: 500_000_000 } },
        fade_out: { type: "Fixed", data: { secs: 0, nanos: 500_000_000 } },
        curve_in: "Linear",
        curve_out: "Linear",
      };
      for (const instruction of cue.instructions) {
        instruction.cue_instruction.values = Object.fromEntries(
          Object.entries({
            Intensity: 1,
            Red: index === 0 ? 1 : 0,
            Green: 0,
            Blue: index === 0 ? 0 : 1,
          }).map(([attribute, value]) => [
            attribute,
            {
              type: "Inline",
              data: { type: "AbsolutePercent", data: { value } },
            },
          ]),
        );
      }
      await send("CueCommand", "StoreCue", cue);
    }
    await send("CueCommand", "StoreSequence", sequence);
    await send("ClipCommand", "StartClip", { type: "Single", data: 21 });
    return (
      Object.values(stores.fixtures.get()).find(
        (fixture: any) => fixture.identifiers.id === 601,
      ) as any
    ).identifiers.uid as string;
  });

  await page
    .getByRole("tab", { name: "3D Visualizer", exact: true })
    .first()
    .click();
  await expect(
    page.locator('[data-panel-id="panel-Visualizer"] canvas').first(),
  ).toBeVisible();
  await page.waitForTimeout(3_000);

  const socket = new WebSocket(`ws://127.0.0.1:${backendSlot.backendPort}/ws`);
  socket.binaryType = "arraybuffer";
  const samples: { time: number; red: number | null }[] = [];
  const metrics: unknown[] = [];
  const observerDelay = monitorEventLoopDelay({ resolution: 10 });
  observerDelay.enable();
  const started = performance.now();
  const parameterStateTag = Buffer.from("ParameterState");
  const metricsTag = Buffer.from("Metrics");
  /** Measures backend publication independently of browser rendering and store throttling. */
  socket.addEventListener("message", (event) => {
    const time = performance.now();
    const bytes = Buffer.from(event.data as ArrayBuffer);
    if (bytes.length < 2) return;
    // The leading CBOR enum tag precedes its data. Decode only sampled colors
    // and small metrics frames so the observer does not add large allocations.
    const header = bytes.subarray(1, 32);
    if (header.includes(metricsTag)) {
      const message = decode(bytes.subarray(1)) as any;
      if (message.type === "Metrics")
        metrics.push({ time, data: message.data });
    }
    if (!header.includes(parameterStateTag) || time - started < 3_000) return;
    let red: number | null = null;
    if (samples.length % 5 === 0) {
      const message = decode(bytes.subarray(1)) as any;
      if (message.type !== "ParameterState")
        throw new Error("Unexpected parameter frame header");
      const row = message.data.find(
        (item: any) => item.fixture_uid === fixtureUid,
      );
      red =
        row?.parameters.find(
          (parameter: any) => parameter.output.Red !== undefined,
        )?.output.Red ?? null;
    }
    samples.push({ time, red });
  });

  try {
    await page.waitForTimeout(
      Number(process.env.NIGHTFALL_AUDIO_CAPTURE_MS ?? 18_000),
    );
    socket.close();
    observerDelay.disable();
    const gaps = samples
      .slice(1)
      .map((sample, index) => sample.time - samples[index].time)
      .sort((a, b) => a - b);
    const summary = {
      samples: samples.length,
      medianGapMs: gaps[Math.floor(gaps.length * 0.5)],
      p99GapMs: gaps[Math.floor(gaps.length * 0.99)],
      maxGapMs: gaps.at(-1),
      gapsOver100Ms: gaps.filter((gap) => gap > 100).length,
      distinctRedValues: new Set(
        samples.map((sample) => sample.red).filter((red) => red !== null),
      ).size,
      observerMaxDelayMs: observerDelay.max / 1e6,
    };
    const capturePath = testInfo.outputPath("output-cadence.json");
    await writeFile(
      capturePath,
      JSON.stringify({ summary, samples, metrics }, null, 2),
    );
    await testInfo.attach("output-cadence.json", {
      path: capturePath,
      contentType: "application/json",
    });
    await page.screenshot({
      path: testInfo.outputPath("color-playback-a.png"),
    });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: testInfo.outputPath("color-playback-b.png"),
    });
    expect(summary.distinctRedValues).toBeGreaterThan(50);
    // Hardware cadence is a characterization, not a real-time scheduling guarantee.
    // The Rust blocked-worker test deterministically enforces nonblocking Update.
  } finally {
    observerDelay.disable();
    socket.close();
    await page.evaluate(async () => {
      await (window as any).appStores.sendAndAwait({
        module: "ClipCommand",
        command: { type: "StopClip", data: { type: "Single", data: 21 } },
      });
    });
  }
});
