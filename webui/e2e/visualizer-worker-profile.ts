// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Page } from "@playwright/test";

/** Records UI and renderer work together when the visualizer runs on the main thread. */
export async function startVisualizerMainProfile(page: Page) {
  const connection = await page.context().newCDPSession(page);
  try {
    await connection.send("Profiler.enable");
    await connection.send("Profiler.setSamplingInterval", { interval: 1000 });
    await connection.send("Profiler.start");
  } catch (error) {
    await connection.detach();
    throw error;
  }
  /** Returns a DevTools-compatible CPU profile and always releases its debugger session. */
  return async () => {
    try {
      return await connection.send("Profiler.stop");
    } finally {
      await connection.detach();
    }
  };
}

/** Connects bounded diagnostic requests to the isolated renderer worker. */
async function connectVisualizerWorker(page: Page) {
  const browser = page.context().browser();
  if (!browser)
    throw new Error("Worker diagnostics require a Chromium browser");
  const connection = await browser.newBrowserCDPSession();
  const { targetInfos } = await connection.send("Target.getTargets");
  const target = targetInfos.find(
    (entry) =>
      entry.type === "worker" &&
      entry.url.includes("/renderers/worker-renderer.ts"),
  );
  if (!target) {
    await connection.detach();
    throw new Error("Visualizer worker target was not found");
  }
  const { sessionId } = await connection.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: false,
  });
  let requestId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  connection.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== sessionId) return;
    const response = JSON.parse(event.message);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  });
  /** Routes one bounded DevTools request to the dedicated worker session. */
  async function send(method: string, params = {}): Promise<unknown> {
    const id = ++requestId;
    let timer: ReturnType<typeof setTimeout>;
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Worker profiler timed out: ${method}`));
      }, 10000);
    });
    try {
      await connection.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      });
      return await result;
    } finally {
      clearTimeout(timer!);
      pending.delete(id);
    }
  }
  return { send, detach: () => connection.detach() };
}

/** Records the renderer worker through CDP without adding instrumentation to production frame submission. */
export async function startVisualizerWorkerProfile(page: Page) {
  const { send, detach } = await connectVisualizerWorker(page);
  try {
    await send("Profiler.enable");
    await send("Profiler.setSamplingInterval", { interval: 1000 });
    await send("Profiler.start");
  } catch (error) {
    await detach();
    throw error;
  }
  /** Stops sampling and releases the debugger connection even if profile retrieval fails. */
  return async () => {
    try {
      return await send("Profiler.stop");
    } finally {
      await detach();
    }
  };
}

/** Masks timestamp support after warmup to isolate query overhead in a disposable test context. */
export async function disableVisualizerGpuTiming(page: Page, worker: boolean) {
  /** Changes only timestamp capability checks; rendering features and existing quality levels remain intact. */
  function disableTimestampQueries() {
    const features = (globalThis as any).GPUSupportedFeatures?.prototype;
    if (!features) throw new Error("WebGPU features interface is unavailable");
    const original = features.has;
    features.has = function (name: string) {
      return name !== "timestamp-query" && original.call(this, name);
    };
  }
  if (!worker) {
    await page.evaluate(disableTimestampQueries);
    return;
  }
  const { send, detach } = await connectVisualizerWorker(page);
  try {
    const result = (await send("Runtime.evaluate", {
      expression: `(${disableTimestampQueries.toString()})()`,
      returnByValue: true,
    })) as { exceptionDetails?: unknown };
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
  } finally {
    await detach();
  }
}
