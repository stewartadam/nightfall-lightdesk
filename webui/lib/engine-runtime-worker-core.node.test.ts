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
  let seq = 0;
  /** Encodes the next keyframe of a one-slot layout. */
  const values = (layoutId: number, red: number) =>
    engineEncoded(1, "ParameterState", keyframeWithRed(layoutId, ++seq, red));
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
  assert.equal(messages.length, 2, "the layout and the latest rebuilt state");
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
    "state rebuilt for an earlier layout is dropped with that layout",
  );
  worker.send({ type: "submit", data: { update: "test" } });
  assert.deepEqual(submitted, { update: "test" });
  worker.send({ type: "stop" });
  assert.equal(stopped, true);
  assert.equal(callbacks?.isCurrent(generation), false);
});

/** Encodes a message map in the engine's `type`-first field order, which cborg would sort. */
function engineEncoded(discriminator: number, type: string, data: unknown) {
  const entries = [encode("type"), encode(type), encode("data"), encode(data)];
  return new Uint8Array([
    discriminator,
    0xa2,
    ...entries.flatMap((entry) => [...entry]),
  ]);
}

/** Builds keyframe `seq` of a one-slot layout with the given red output and no assertions. */
function keyframeWithRed(layoutId: number, seq: number, red: number) {
  return {
    layout_id: layoutId,
    seq,
    keyframe: true,
    verifiable: false,
    changed_slots: new Uint8Array(),
    output: new Uint8Array(Float32Array.of(red).buffer),
    assertions_included: true,
    absolute_count: 0,
    assertion_slots: new Uint8Array(),
    assertion_kinds: new Uint8Array(),
    assertion_values: new Uint8Array(),
  };
}

/** Builds delta `seq` of a one-slot layout that changes red and leaves assertions alone. */
function deltaWithRed(layoutId: number, seq: number, red: number) {
  return {
    ...keyframeWithRed(layoutId, seq, red),
    keyframe: false,
    changed_slots: new Uint8Array(Uint32Array.of(0).buffer),
    assertions_included: false,
  };
}

/** Encodes the backend's one-slot layout with the Red attribute. */
function redLayout(layoutId: number) {
  return engineEncoded(0, "ParameterLayout", {
    layout_id: layoutId,
    fixtures: [{ fixture_uid: "fixture", elements: [["Red"]] }],
    assertion_variants: ["Absolute"],
  });
}

/**
 * A command result is pulled in the same batch as the newest snapshot published before it,
 * so the main thread applies that state before settling the command, and a superseded
 * snapshot is never delivered.
 */
test("pulls deliver command results with the newest staged snapshot", (t) => {
  const worker = workerHarness(t);
  let callbacks: Parameters<EmbeddedRuntimeFactory>[0] | undefined;
  startEngineRuntimeWorker((hooks) => {
    callbacks = hooks;
    return {
      /** Skip demo loading; the test publishes engine output directly. */
      async start() {},
      /** No adapter resources to release. */
      stop() {},
      /** Commands are not exercised here. */
      submit() {},
      /** Leave periodic metrics inactive in this protocol test. */
      postInfo() {},
    };
  });
  worker.send({
    type: "start",
    config: { mode: "embedded-demo", sampleId: "test", showfileUrl: "/s" },
  });
  const result = { command_id: "c1", outcome: { type: "Succeeded" } };
  callbacks?.processEncodedPublication(redLayout(1));
  callbacks?.processEncodedPublication(
    engineEncoded(1, "ParameterState", keyframeWithRed(1, 1, 0)),
  );
  callbacks?.processEncodedPublication(
    engineEncoded(1, "ParameterState", keyframeWithRed(1, 2, 255)),
  );
  callbacks?.processEncodedPublication(
    engineEncoded(0, "CommandResult", result),
  );
  assert.deepEqual(worker.publications.at(-1), { type: "commandResultReady" });

  worker.send({ type: "pullFrame" });
  const batch = worker.publications.at(-1).messages;
  assert.deepEqual(
    batch.map((message: { messageType: string }) => message.messageType),
    ["ParameterLayout", "CommandResult", "ParameterState"],
  );
  assert.deepEqual(batch[1].data, { type: "CommandResult", data: result });
  const decoder = new ParameterStateDecoder();
  assert.equal(queuedWorkerMessageData(batch[0], decoder), undefined);
  assert.deepEqual(queuedWorkerMessageData(batch[2], decoder), {
    type: "ParameterState",
    data: [
      {
        fixture_uid: "fixture",
        parameters: [{ output: { Red: 255 }, absolute: {}, relative: {} }],
      },
    ],
  });

  callbacks?.processEncodedPublication(
    engineEncoded(1, "ParameterState", keyframeWithRed(2, 3, 128)),
  );
  worker.send({ type: "pullFrame" });
  assert.deepEqual(
    worker.publications.at(-1).messages,
    [],
    "a frame for a layout other than the latest is never delivered",
  );
});

/** Minimal browser WebSocket stand-in whose open and close the test drives. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  /** Registers the socket so the test can open or close it. */
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  /** Records a frame the worker sends, leaving out its own heartbeats. */
  send(data: string): void {
    if (!data.includes('"WebSocketHeartbeat"')) this.sent.push(data);
  }

  /** Finishes the handshake the way a browser socket does. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /**
   * Closes the socket the way a browser does after a failed or ended connection, reporting
   * `code` as the close code (1006, abnormal closure, by default).
   */
  close(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Installs `FakeSocket` as the global WebSocket and stops reconnect timers for one test. */
function installFakeSocket(t: TestContext): void {
  FakeSocket.instances = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeSocket,
  });
  t.mock.method(
    globalThis,
    "setTimeout",
    () => 1 as unknown as ReturnType<typeof setTimeout>,
  );
  /** Restores the platform WebSocket. */
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "WebSocket", previous);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });
}

/** Commands submitted while the socket is still opening reach the backend, in order, once it opens. */
test("submits sent while connecting are delivered when the socket opens", (t) => {
  const worker = workerHarness(t);
  installFakeSocket(t);
  startEngineRuntimeWorker();
  worker.send({
    type: "start",
    config: { mode: "remote", websocketUrl: "ws://backend/ws" },
  });
  const socket = FakeSocket.instances[0];
  worker.send({ type: "submit", data: { command_id: "first" } });
  worker.send({ type: "submit", data: { command_id: "second" } });
  assert.deepEqual(socket.sent, []);

  socket.open();

  assert.deepEqual(socket.sent, [
    JSON.stringify({ command_id: "first" }),
    JSON.stringify({ command_id: "second" }),
  ]);
  worker.send({ type: "stop" });
});

/**
 * A client the backend disconnects for falling behind reconnects without the usual delay, a
 * second lagging disconnect soon after backs off to the normal delay, and any other close waits a
 * second before retrying.
 */
test("lagging disconnects reconnect immediately once", (t) => {
  const worker = workerHarness(t);
  installFakeSocket(t);
  const timers = (
    globalThis.setTimeout as unknown as {
      mock: { calls: { arguments: unknown[] }[] };
    }
  ).mock;
  startEngineRuntimeWorker();
  worker.send({
    type: "start",
    config: { mode: "remote", websocketUrl: "ws://backend/ws" },
  });
  const reconnectDelays = () =>
    timers.calls
      .map((call) => call.arguments[1])
      .filter((delay) => delay === 0 || delay === 1000);

  /** Restarts the worker connection, then opens and closes its socket with `code`. */
  const reconnectAndClose = (code?: number) => {
    worker.send({ type: "stop" });
    worker.send({
      type: "start",
      config: { mode: "remote", websocketUrl: "ws://backend/ws" },
    });
    FakeSocket.instances.at(-1)!.open();
    FakeSocket.instances.at(-1)!.close(code);
  };

  FakeSocket.instances[0].open();
  FakeSocket.instances[0].close(4001);
  assert.deepEqual(reconnectDelays(), [0]);

  reconnectAndClose(4001);
  assert.deepEqual(reconnectDelays(), [0, 1000]);

  reconnectAndClose();
  assert.deepEqual(reconnectDelays(), [0, 1000, 1000]);

  worker.send({ type: "stop" });
});

/**
 * Deltas are applied as they arrive, so a pull delivers state built from every frame rather than
 * only the newest one. A missed frame stops delivery and sends one keyframe request however many
 * deltas follow, and the next keyframe resumes delivery.
 */
test("parameter frame gaps request a keyframe", (t) => {
  const worker = workerHarness(t);
  installFakeSocket(t);
  startEngineRuntimeWorker();
  worker.send({
    type: "start",
    config: { mode: "remote", websocketUrl: "ws://backend/ws" },
  });
  const socket = FakeSocket.instances[0];
  socket.open();
  /** Delivers one engine publication through the socket. */
  const receive = (bytes: Uint8Array) =>
    socket.onmessage?.({ data: bytes.slice().buffer } as MessageEvent);
  /** Pulls a batch and returns the red output its parameter state carries, if any. */
  const pulledRed = () => {
    worker.send({ type: "pullFrame" });
    const batch = worker.publications.at(-1).messages;
    const packed = batch.find(
      (message: { packedParameters?: unknown }) => message.packedParameters,
    )?.packedParameters;
    return packed?.output[0];
  };
  const keyframeRequests = () =>
    socket.sent.filter((data) => data.includes("ParameterKeyframeRequest"));

  receive(redLayout(1));
  receive(engineEncoded(1, "ParameterState", keyframeWithRed(1, 1, 10)));
  receive(engineEncoded(1, "ParameterState", deltaWithRed(1, 2, 20)));
  assert.equal(pulledRed(), 20);
  assert.equal(pulledRed(), undefined, "unchanged state is not redelivered");

  receive(engineEncoded(1, "ParameterState", deltaWithRed(1, 4, 40)));
  receive(engineEncoded(1, "ParameterState", deltaWithRed(1, 5, 50)));
  assert.equal(pulledRed(), undefined, "deltas after a gap are not applied");
  assert.deepEqual(keyframeRequests(), [
    JSON.stringify({ module: "ParameterKeyframeRequest", update: {} }),
  ]);

  receive(engineEncoded(1, "ParameterState", keyframeWithRed(1, 6, 60)));
  receive(engineEncoded(1, "ParameterState", deltaWithRed(1, 7, 70)));
  assert.equal(pulledRed(), 70);
  worker.send({ type: "stop" });
});

/**
 * After a resync request or a new layout, no parameter state is delivered until a keyframe for
 * the current layout arrives, and a layout and the state built on it arrive in that order.
 */
test("resyncs and relayouts withhold state until a keyframe", (t) => {
  const worker = workerHarness(t);
  let callbacks: Parameters<EmbeddedRuntimeFactory>[0] | undefined;
  startEngineRuntimeWorker((hooks) => {
    callbacks = hooks;
    return {
      /** Skip demo loading; the test publishes engine output directly. */
      async start() {},
      /** No adapter resources to release. */
      stop() {},
      /** Keyframe requests are covered by another test. */
      submit() {},
      /** Leave periodic metrics inactive in this protocol test. */
      postInfo() {},
    };
  });
  worker.send({
    type: "start",
    config: { mode: "embedded-demo", sampleId: "test", showfileUrl: "/s" },
  });
  /** Publishes one engine message to the worker. */
  const publish = (bytes: Uint8Array) =>
    callbacks?.processEncodedPublication(bytes);
  /** Pulls a batch and returns its message types in delivery order. */
  const pulledTypes = () => {
    worker.send({ type: "pullFrame" });
    return worker.publications
      .at(-1)
      .messages.map((message: { messageType: string }) => message.messageType);
  };

  publish(redLayout(1));
  publish(engineEncoded(1, "ParameterState", keyframeWithRed(1, 1, 10)));
  assert.deepEqual(pulledTypes(), ["ParameterLayout", "ParameterState"]);

  worker.send({ type: "resumeAfterResyncRequest" });
  publish(engineEncoded(1, "ParameterState", deltaWithRed(1, 2, 20)));
  assert.deepEqual(pulledTypes(), [], "state waits for the resync's layout");

  publish(redLayout(2));
  publish(engineEncoded(1, "ParameterState", deltaWithRed(1, 3, 30)));
  assert.deepEqual(pulledTypes(), ["ParameterLayout"]);

  publish(engineEncoded(1, "ParameterState", keyframeWithRed(2, 4, 40)));
  publish(redLayout(3));
  assert.deepEqual(
    pulledTypes(),
    ["ParameterLayout"],
    "state for a replaced layout is never delivered",
  );
  worker.send({ type: "stop" });
});

/**
 * In the demo engine a keyframe request runs an engine tick, so it is deferred until the
 * publication batch that revealed the gap has been processed.
 */
test("demo keyframe requests wait for the current batch", async (t) => {
  const worker = workerHarness(t);
  let callbacks: Parameters<EmbeddedRuntimeFactory>[0] | undefined;
  const submitted: unknown[] = [];
  startEngineRuntimeWorker((hooks) => {
    callbacks = hooks;
    return {
      /** Skip demo loading; the test publishes engine output directly. */
      async start() {},
      /** No adapter resources to release. */
      stop() {},
      /** Record forwarded keyframe requests. */
      submit(data) {
        submitted.push(data);
      },
      /** Leave periodic metrics inactive in this protocol test. */
      postInfo() {},
    };
  });
  worker.send({
    type: "start",
    config: { mode: "embedded-demo", sampleId: "test", showfileUrl: "/s" },
  });
  callbacks?.processEncodedPublication(redLayout(1));
  callbacks?.processEncodedPublication(
    engineEncoded(1, "ParameterState", keyframeWithRed(1, 1, 10)),
  );
  callbacks?.processEncodedPublication(
    engineEncoded(1, "ParameterState", deltaWithRed(1, 3, 30)),
  );
  assert.deepEqual(submitted, [], "nothing is submitted mid-batch");
  await Promise.resolve();
  assert.deepEqual(submitted, [
    { module: "ParameterKeyframeRequest", update: {} },
  ]);
  worker.send({ type: "stop" });
});

/** A socket that closes before opening drops its waiting submits instead of replaying them on the next connection. */
test("submits waiting on a socket that closes are not sent on reconnect", (t) => {
  const worker = workerHarness(t);
  installFakeSocket(t);
  startEngineRuntimeWorker();
  worker.send({
    type: "start",
    config: { mode: "remote", websocketUrl: "ws://backend/ws" },
  });
  worker.send({ type: "submit", data: { command_id: "lost" } });
  FakeSocket.instances[0].close();
  worker.send({
    type: "start",
    config: { mode: "remote", websocketUrl: "ws://backend/ws" },
  });
  const reconnected = FakeSocket.instances.at(-1)!;

  reconnected.open();

  assert.deepEqual(reconnected.sent, []);
  worker.send({ type: "stop" });
});
