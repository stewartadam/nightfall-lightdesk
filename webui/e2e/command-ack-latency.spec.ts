// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(60_000);

const ACK_LATENCY_SAMPLE_COUNT = 20;
const TWO_FRAME_ACK_BUDGET_MS = 75;

interface CommandLatencySample {
  ackMs: number;
  submitMs: number;
  totalMs: number;
}

interface CommandLatencySummary {
  commandLineEval: CommandLatencySample[];
  directAckMs: number[];
  fixtureCount: number;
  fixtureId: number;
  programmerCommandLine: CommandLatencySample[];
}

/** Returns the requested percentile from a sorted copy of the supplied samples. */
function percentile(samples: number[], percentileValue: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

/** Waits until the application websocket transport can complete an awaited command. */
async function waitForCommandTransport(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return typeof stores?.sendAndAwait === "function";
      }),
    )
    .toBe(true);

  await page.evaluate(async () => {
    const result = await (window as any).appStores.sendAndAwait({
      module: "EngineCommand",
      command: { type: "SetFps", data: 44 },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(
        `command transport probe failed: ${JSON.stringify(result)}`,
      );
    }
  });
}

/** Creates one owned fixture so the command-line probe traverses programmer systems. */
async function createLatencyFixture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const result = await (window as any).appStores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: 987_654,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: "Command ACK Latency Fixture",
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(`fixture setup failed: ${JSON.stringify(result)}`);
    }
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys((window as any).appStores?.fixtures?.get?.() ?? {})
            .length,
      ),
    )
    .toBe(1);
}

/** Measures direct UI-transport command round trips and command-line submission phases. */
async function measureCommandLatency(
  page: Page,
): Promise<CommandLatencySummary> {
  return page.evaluate(
    async ({ sampleCount }) => {
      const stores = (window as any).appStores;
      const fixtures = Object.values(stores.fixtures.get()) as Array<{
        identifiers: { id: number };
      }>;
      const fixtureId = fixtures[0]?.identifiers.id;
      if (fixtureId === undefined) {
        throw new Error(
          "loaded showfile did not expose a fixture for measurement",
        );
      }
      const directAckMs: number[] = [];
      for (let index = 0; index < sampleCount; index++) {
        const startedAt = performance.now();
        const result = await stores.sendAndAwait({
          module: "EngineCommand",
          command: { type: "SetFps", data: 44 },
        });
        if (result.outcome.type !== "Succeeded") {
          throw new Error(`direct command failed: ${JSON.stringify(result)}`);
        }
        directAckMs.push(performance.now() - startedAt);
      }

      const input = document.querySelector<HTMLInputElement>("#header-cmdline");
      if (!input?.form) {
        throw new Error("header command line was unavailable");
      }

      /** Submits one operator command and measures its validation and ACK phases. */
      const measureCommandLine = async (
        command: string,
      ): Promise<CommandLatencySample> => {
        input.value = command;
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));

        const initialLength = stores.consoleScrollback.get().length;
        let pendingAt: number | undefined;
        const startedAt = performance.now();
        const completedAt = await new Promise<number>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            unsubscribe();
            reject(new Error("command-line ACK measurement timed out"));
          }, 5_000);
          const unsubscribe = stores.consoleScrollback.subscribe(
            (entries: Array<{ status: string }>) => {
              if (entries.length <= initialLength) return;
              const latest = entries.at(-1);
              if (!latest) return;
              if (latest.status === "pending") {
                pendingAt ??= performance.now();
                return;
              }
              if (pendingAt === undefined) return;
              window.clearTimeout(timeout);
              unsubscribe();
              resolve(performance.now());
            },
          );

          input.form?.requestSubmit();
        });

        return {
          submitMs: pendingAt! - startedAt,
          ackMs: completedAt - pendingAt!,
          totalMs: completedAt - startedAt,
        };
      };

      const commandLineEval: CommandLatencySample[] = [];
      for (let index = 0; index < sampleCount; index++) {
        commandLineEval.push(await measureCommandLine("fps 44"));
      }

      const programmerCommandLine: CommandLatencySample[] = [];
      for (let index = 0; index < sampleCount; index++) {
        programmerCommandLine.push(
          await measureCommandLine(
            `fix ${fixtureId} @ ${index % 2 === 0 ? 99 : 100}`,
          ),
        );
      }

      return {
        commandLineEval,
        directAckMs,
        fixtureCount: fixtures.length,
        fixtureId,
        programmerCommandLine,
      };
    },
    { sampleCount: ACK_LATENCY_SAMPLE_COUNT },
  );
}

/** Measures an awaited command while browser animation frames are throttled. */
async function measureThrottledFrameCommandLatency(
  page: Page,
): Promise<number[]> {
  return page.evaluate(
    async ({ sampleCount }) => {
      const originalRequestAnimationFrame = window.requestAnimationFrame;
      const originalCancelAnimationFrame = window.cancelAnimationFrame;
      window.requestAnimationFrame = (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 1_000);
      window.cancelAnimationFrame = (handle: number) =>
        window.clearTimeout(handle);
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        const samples: number[] = [];
        for (let index = 0; index < sampleCount; index++) {
          const startedAt = performance.now();
          const result = await (window as any).appStores.sendAndAwait({
            module: "EngineCommand",
            command: { type: "SetFps", data: 44 },
          });
          if (result.outcome.type !== "Succeeded") {
            throw new Error(
              `throttled-frame command failed: ${JSON.stringify(result)}`,
            );
          }
          samples.push(performance.now() - startedAt);
        }
        return samples;
      } finally {
        window.requestAnimationFrame = originalRequestAnimationFrame;
        window.cancelAnimationFrame = originalCancelAnimationFrame;
      }
    },
    { sampleCount: ACK_LATENCY_SAMPLE_COUNT },
  );
}

/** Verifies UI command acknowledgements complete within a few backend and browser frames. */
test("UI commands receive expedient acknowledgements", async ({
  backendSlot,
  page,
}) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall.currentShowfileName");
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto("/?e2e=1&startup:draftRecovery=false");
  await waitForDockviewApp(page, { timeoutMs: 60_000 });
  await expect(page.getByRole("navigation", { name: "Global" })).toBeVisible();
  await waitForCommandTransport(page);
  await createLatencyFixture(page);

  const summary = await measureCommandLatency(page);
  const throttledFrameAckMs = await measureThrottledFrameCommandLatency(page);
  const commandLineEvalAckMs = summary.commandLineEval.map(
    (sample) => sample.ackMs,
  );
  const programmerCommandLineAckMs = summary.programmerCommandLine.map(
    (sample) => sample.ackMs,
  );
  const programmerCommandLineSubmitMs = summary.programmerCommandLine.map(
    (sample) => sample.submitMs,
  );
  console.info(
    JSON.stringify(
      {
        commandAckLatency: {
          directAckMs: summary.directAckMs,
          fixtureCount: summary.fixtureCount,
          fixtureId: summary.fixtureId,
          throttledFrameAckMs,
          commandLineEval: summary.commandLineEval,
          programmerCommandLine: summary.programmerCommandLine,
          p95: {
            directAckMs: percentile(summary.directAckMs, 95),
            throttledFrameAckMs: percentile(throttledFrameAckMs, 95),
            commandLineEvalAckMs: percentile(commandLineEvalAckMs, 95),
            programmerCommandLineAckMs: percentile(
              programmerCommandLineAckMs,
              95,
            ),
            programmerCommandLineSubmitMs: percentile(
              programmerCommandLineSubmitMs,
              95,
            ),
          },
        },
      },
      null,
      2,
    ),
  );

  expect(percentile(summary.directAckMs, 95)).toBeLessThan(
    TWO_FRAME_ACK_BUDGET_MS,
  );
  expect(percentile(commandLineEvalAckMs, 95)).toBeLessThan(
    TWO_FRAME_ACK_BUDGET_MS,
  );
  expect(percentile(programmerCommandLineAckMs, 95)).toBeLessThan(
    TWO_FRAME_ACK_BUDGET_MS,
  );
  expect(percentile(throttledFrameAckMs, 95)).toBeLessThan(
    TWO_FRAME_ACK_BUDGET_MS,
  );
});
