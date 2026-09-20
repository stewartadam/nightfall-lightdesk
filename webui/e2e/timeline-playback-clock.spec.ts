// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Page,
  frontendOnlyTest as test,
} from "./playwright-fixtures";

/** Loads an isolated production controller with a controllable browser clock. */
async function openPlaybackClock(page: Page) {
  await page.route("**/playback-clock", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><script type="module" src="/e2e/fixtures/timeline-playback.ts"></script></body></html>',
    }),
  );
  await page.clock.install();
  await page.goto("/playback-clock");
  await page.evaluate(() => import("/e2e/fixtures/timeline-playback.ts"));
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
}

/** Reproduces the phase mismatch between 44 Hz engine snapshots and browser ticks. */
test("timecode snapshots do not double-count part of the previous animation tick", async ({
  page,
}) => {
  await openPlaybackClock(page);
  await page.evaluate(async () => {
    const { playback } = await import("/e2e/fixtures/timeline-playback.ts");
    const { TimelineTriggerMode } = await import("/types/index.ts");
    const origin = performance.now();
    const samples: { actual: number; expected: number }[] = [];
    (window as any).playbackClockSamples = samples;
    /** Publishes the ideal backend clock at five 44 Hz engine frames per snapshot. */
    const snapshot = () => {
      const ms = performance.now() - origin;
      playback.syncTimecodeState({
        currentTime: { secs: 0, nanos: ms * 1e6 },
        isActive: true,
        triggerMode: TimelineTriggerMode.FollowTimecode,
      });
    };
    snapshot();
    const interval = setInterval(snapshot, 114);
    /** Reads the playhead after each presentation update without adding wall-clock noise. */
    const sample = () => {
      samples.push({
        actual: playback.position(),
        expected: performance.now() - origin,
      });
      if (performance.now() - origin < 2000) requestAnimationFrame(sample);
      else {
        clearInterval(interval);
        playback.stop();
      }
    };
    requestAnimationFrame(sample);
  });
  await page.clock.runFor(2100);
  const samples = await page.evaluate(
    () =>
      (window as any).playbackClockSamples as {
        actual: number;
        expected: number;
      }[],
  );
  const errors = samples.map(({ actual, expected }) =>
    Math.abs(actual - expected),
  );
  await test.info().attach("clock-errors", {
    body: JSON.stringify(samples),
    contentType: "application/json",
  });
  expect(samples.length).toBeGreaterThan(100);
  expect(Math.max(...errors)).toBeLessThan(0.1);
});

/** Keeps seeks and loop wraps immediate and cancels animation on every stop path. */
test("playback anchors follow seeks, wraps, pauses and disposal", async ({
  page,
}) => {
  await openPlaybackClock(page);
  await page.evaluate(async () => {
    const { playback } = await import("/e2e/fixtures/timeline-playback.ts");
    const { TimelineTriggerMode } = await import("/types/index.ts");
    playback.syncTimecodeState({
      currentTime: { secs: 10, nanos: 0 },
      isActive: true,
      triggerMode: TimelineTriggerMode.FollowTimecode,
    });
  });
  await page.clock.runFor(100);
  /** Reads the live clock without involving DOM rounding. */
  const position = () =>
    page.evaluate(async () =>
      (await import("/e2e/fixtures/timeline-playback.ts")).playback.position(),
    );
  expect(await position()).toBeGreaterThan(10050);
  await page.evaluate(async () =>
    (await import("/e2e/fixtures/timeline-playback.ts")).playback.seek(500),
  );
  await page.clock.runFor(100);
  expect(await position()).toBeGreaterThan(550);
  expect(await position()).toBeLessThan(700);
  await page.evaluate(async () => {
    const { playback } = await import("/e2e/fixtures/timeline-playback.ts");
    const { TimelineTriggerMode } = await import("/types/index.ts");
    playback.syncTimecodeState({
      currentTime: { secs: 0, nanos: 0 },
      isActive: true,
      triggerMode: TimelineTriggerMode.FollowTimecode,
    });
  });
  await page.clock.runFor(100);
  expect(await position()).toBeGreaterThan(50);
  expect(await position()).toBeLessThan(200);
  for (const operation of [
    "pause",
    "stopLocalPlaybackState",
    "reset",
    "stop",
  ] as const) {
    await page.evaluate(async (operation) => {
      const { playback } = await import("/e2e/fixtures/timeline-playback.ts");
      const { TimelineTriggerMode } = await import("/types/index.ts");
      playback.syncTimecodeState({
        currentTime: { secs: 1, nanos: 0 },
        isActive: true,
        triggerMode: TimelineTriggerMode.FollowTimecode,
      });
      playback[operation]();
    }, operation);
    const stoppedPosition = await position();
    await page.clock.runFor(100);
    expect(await position()).toBe(stoppedPosition);
  }
  await page.evaluate(async () => {
    const { playback, dispose } = await import(
      "/e2e/fixtures/timeline-playback.ts"
    );
    const { TimelineTriggerMode } = await import("/types/index.ts");
    playback.syncTimecodeState({
      currentTime: { secs: 2, nanos: 0 },
      isActive: true,
      triggerMode: TimelineTriggerMode.FollowTimecode,
    });
    dispose();
  });
  const disposedPosition = await position();
  await page.clock.runFor(100);
  expect(await position()).toBe(disposedPosition);
});

/** Delayed snapshots correct phase gradually without reversing the playhead. */
test("variable snapshot delivery preserves continuous forward playback", async ({
  page,
}) => {
  await openPlaybackClock(page);
  await page.evaluate(async () => {
    const { playback } = await import("/e2e/fixtures/timeline-playback.ts");
    const { TimelineTriggerMode } = await import("/types/index.ts");
    const origin = performance.now();
    /** Publishes a backend timestamp independently of its delivery time. */
    const snapshot = (ms: number) =>
      playback.syncTimecodeState({
        currentTime: { secs: 0, nanos: ms * 1e6 },
        isActive: true,
        triggerMode: TimelineTriggerMode.FollowTimecode,
      });
    snapshot(0);
    for (let index = 1; index <= 15; index++) {
      const sourceTime = index * 114;
      setTimeout(() => snapshot(sourceTime), sourceTime + (index % 3) * 20);
    }
    const samples: { position: number; elapsed: number }[] = [];
    (window as any).delayedClockSamples = samples;
    /** Captures phase corrections at each presentation tick. */
    const sample = () => {
      samples.push({
        position: playback.position(),
        elapsed: performance.now() - origin,
      });
      if (performance.now() - origin < 2000) requestAnimationFrame(sample);
      else playback.stop();
    };
    requestAnimationFrame(sample);
  });
  await page.clock.runFor(2100);
  const samples = await page.evaluate(
    () =>
      (window as any).delayedClockSamples as {
        position: number;
        elapsed: number;
      }[],
  );
  for (let index = 1; index < samples.length; index++) {
    const delta = samples[index].position - samples[index - 1].position;
    const elapsed = samples[index].elapsed - samples[index - 1].elapsed;
    expect(delta / elapsed).toBeGreaterThanOrEqual(0.899);
    expect(delta / elapsed).toBeLessThanOrEqual(1.101);
    expect(
      Math.abs(samples[index].position - samples[index].elapsed),
    ).toBeLessThan(41);
  }
});
