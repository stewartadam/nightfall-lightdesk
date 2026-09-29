// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as Comlink from "comlink";
import type {
  VisualizerWorkerApi,
  WorkerRendererProxy,
} from "./worker-renderer";

/** Worker API calls observed by a fake Comlink remote. */
interface RecordedCall {
  method: string;
  args: unknown[];
}

/** Per-method results for the fake remote; unlisted methods resolve immediately. */
type RemoteBehaviour = Partial<Record<string, (...args: unknown[]) => unknown>>;

const animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 1;

/**
 * Installs the worker-scope and animation-frame globals the renderer module
 * touches at import time and in its colour loop, then loads it. The module
 * registers its own Comlink endpoint on `self`, which a node global lacks.
 */
async function loadProxyModule(): Promise<typeof import("./worker-renderer")> {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.self ??= globalThis;
  scope.addEventListener ??= () => {};
  scope.removeEventListener ??= () => {};
  scope.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  };
  scope.cancelAnimationFrame = (id: number) => {
    animationFrames.delete(id);
  };
  return import("./worker-renderer");
}

/** Runs every queued animation frame callback once, as one browser frame would. */
function runAnimationFrame(): void {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of callbacks) callback(performance.now());
}

/** Lets mailbox acknowledgements and rejections settle before the next frame. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Builds a proxy over a fake worker and Comlink remote that records each
 * method call, so tests observe exactly which messages reach the worker.
 */
async function createProxy(behaviour: RemoteBehaviour = {}): Promise<{
  proxy: WorkerRendererProxy;
  calls: RecordedCall[];
  terminated: () => number;
}> {
  const { WorkerRendererProxy } = await loadProxyModule();
  const calls: RecordedCall[] = [];
  const remote = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then" || typeof property !== "string")
          return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: property, args });
          const handler = behaviour[property];
          return handler ? handler(...args) : Promise.resolve(undefined);
        };
      },
    },
  ) as Comlink.Remote<VisualizerWorkerApi>;
  let terminations = 0;
  const worker = {
    terminate: () => {
      terminations += 1;
    },
  } as unknown as Worker;
  return {
    proxy: new WorkerRendererProxy(worker, remote),
    calls,
    terminated: () => terminations,
  };
}

/** Counts how often the proxy handed a DMX snapshot to the worker. */
function dmxSends(calls: readonly RecordedCall[]): number {
  return calls.filter((call) => call.method === "setElementDmxBatch").length;
}

/** A rejected snapshot is resent on the next frame even though the static look never changes revision. */
test("worker proxy resends a DMX snapshot whose delivery failed", async () => {
  let failing = true;
  const { proxy, calls } = await createProxy({
    setElementDmxBatch: () =>
      failing
        ? Promise.reject(new Error("worker busy"))
        : Promise.resolve(undefined),
  });
  // Resuming from pause starts the colour loop without an OffscreenCanvas.
  proxy.pause();
  proxy.resume();
  runAnimationFrame();
  assert.equal(dmxSends(calls), 1);
  await settle();
  runAnimationFrame();
  assert.equal(dmxSends(calls), 2);

  failing = false;
  await settle();
  runAnimationFrame();
  assert.equal(dmxSends(calls), 3);
  await settle();
  runAnimationFrame();
  await settle();
  runAnimationFrame();
  assert.equal(dmxSends(calls), 3, "a delivered static look is not resent");
  proxy.dispose();
});
