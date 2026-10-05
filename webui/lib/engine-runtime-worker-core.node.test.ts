// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { encode } from "cborg";
import type { EngineRuntimeWorkerRequest } from "./engine-runtime-protocol";
import {
  type EmbeddedRuntimeFactory,
  startEngineRuntimeWorker,
} from "./engine-runtime-worker-core";
import {
  ParameterStateDecoder,
  queuedWorkerMessageData,
} from "./parameter-state-transfer";

/** Capture worker publications and suppress background timers for deterministic protocol checks. */
function workerHarness(t: TestContext) {
  const publications: any[] = [];
  const worker = {
    onmessage: null as
      | ((event: MessageEvent<EngineRuntimeWorkerRequest>) => void)
      | null,
    /** Capture structured-clone messages sent to the main thread. */
    postMessage(message: unknown, options?: StructuredSerializeOptions) {
      publications.push(structuredClone(message, options));
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: worker,
  });
  t.mock.method(
    globalThis,
    "setInterval",
    () => 1 as unknown as ReturnType<typeof setInterval>,
  );
  /** Restore the process-global worker facade after each test. */
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "self", previous);
    else Reflect.deleteProperty(globalThis, "self");
  });
  return {
    publications,
    /** Deliver one main-thread request through the installed worker handler. */
    send(data: EngineRuntimeWorkerRequest) {
      worker.onmessage?.({ data } as MessageEvent<EngineRuntimeWorkerRequest>);
    },
  };
}

/** A native entry point must reject demo startup without importing or constructing a demo engine. */
test("native worker explicitly rejects embedded startup", (t) => {
  const worker = workerHarness(t);
  startEngineRuntimeWorker();
  worker.send({
    type: "start",
    config: {
      mode: "embedded-demo",
      sampleId: "test",
      showfileUrl: "/show.json",
    },
  });
  assert.ok(
    worker.publications.some(
      (message) =>
        message.type === "error" && message.error.includes("does not include"),
    ),
  );
  assert.deepEqual(worker.publications.at(-1), {
    type: "status",
    status: "disconnected",
  });
  worker.send({ type: "stop" });
});

/** Both adapters share decoding and frame delivery, while stop invalidates asynchronous demo startup. */
test("demo adapter shares worker delivery and honors cancellation", (t) => {
  const worker = workerHarness(t);
  let callbacks: Parameters<EmbeddedRuntimeFactory>[0] | undefined;
  let generation = 0;
  let stopped = false;
  let submitted: unknown;
  startEngineRuntimeWorker((hooks) => {
    callbacks = hooks;
    return {
      /** Record the worker's startup generation without loading real WASM. */
      async start(_config, current) {
        generation = current;
      },
      /** Record adapter teardown. */
      stop() {
        stopped = true;
      },
      /** Record a forwarded command. */
      submit(data) {
        submitted = data;
      },
      /** Leave periodic metrics inactive in this protocol test. */
      postInfo() {},
    };
  });
  worker.send({
    type: "start",
    config: {
      mode: "embedded-demo",
      sampleId: "test",
      showfileUrl: "/show.json",
    },
  });
  assert.equal(callbacks?.isCurrent(generation), true);
  const payload = { type: "FixtureUpdate", data: { id: 1 } };
  callbacks?.processEncodedPublication(new Uint8Array([0, ...encode(payload)]));
  worker.send({ type: "pullFrame" });
  assert.deepEqual(worker.publications.at(-1).messages[0].data, payload);
  /** Encodes one values frame with a single output slot. */
  const values = (layoutId: number, red: number) =>
    new Uint8Array([
      1,
      ...encode({
        type: "ParameterState",
        data: {
          layout_id: layoutId,
          output: new Uint8Array(Float32Array.of(red).buffer),
          absolute_count: 0,
          assertion_slots: new Uint8Array(),
          assertion_kinds: new Uint8Array(),
          assertion_values: new Uint8Array(),
        },
      }),
    ]);
  /** Encodes a layout with one fixture whose only slot is `attribute`. */
  const layout = (layoutId: number, attribute: string) =>
    new Uint8Array([
      0,
      ...encode({
        type: "ParameterLayout",
        data: {
          layout_id: layoutId,
          fixtures: [{ fixture_uid: "fixture", elements: [[attribute]] }],
          assertion_variants: ["Absolute"],
        },
      }),
    ]);
  callbacks?.processEncodedPublication(values(1, 1));
  callbacks?.processEncodedPublication(layout(1, "Red"));
  callbacks?.processEncodedPublication(values(1, 2));
  callbacks?.processEncodedPublication(values(1, 255));
  worker.send({ type: "pullFrame" });
  const messages = worker.publications.at(-1).messages;
  assert.equal(messages.length, 2, "the layout and the newest values frame");
  assert.equal(messages[0].data.type, "ParameterLayout");
  assert.equal(messages[1].data, undefined);
  const decoder = new ParameterStateDecoder();
  assert.equal(queuedWorkerMessageData(messages[0], decoder), undefined);
  assert.deepEqual(queuedWorkerMessageData(messages[1], decoder), {
    type: "ParameterState",
    data: [
      {
        fixture_uid: "fixture",
        parameters: [{ output: { Red: 255 }, absolute: {}, relative: {} }],
      },
    ],
  });

  callbacks?.processEncodedPublication(values(1, 3));
  callbacks?.processEncodedPublication(layout(2, "Blue"));
  callbacks?.processEncodedPublication(values(1, 4));
  worker.send({ type: "pullFrame" });
  const relayout = worker.publications.at(-1).messages;
  assert.deepEqual(
    relayout.map((message: { data?: { type: string } }) => message.data?.type),
    ["ParameterLayout"],
    "values staged or received for an earlier layout are dropped",
  );
  worker.send({ type: "submit", data: { update: "test" } });
  assert.deepEqual(submitted, { update: "test" });
  worker.send({ type: "stop" });
  assert.equal(stopped, true);
  assert.equal(callbacks?.isCurrent(generation), false);
});
