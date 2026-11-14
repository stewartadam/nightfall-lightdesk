// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createUnconfirmedEdits,
  createUnconfirmedPatches,
} from "./unconfirmed-edits";

/** A send whose completion the test controls, recording every value it was asked to send. */
function controlledSend<V>() {
  const sent: V[] = [];
  const settlers: Array<(ok: boolean) => void> = [];
  return {
    sent,
    send: (value: V) => {
      sent.push(value);
      return new Promise<void>((resolve, reject) => {
        settlers.push((ok) => (ok ? resolve() : reject(new Error("failed"))));
      });
    },
    /** Settles the oldest unsettled send and lets its continuation run. */
    async settleNext(ok = true) {
      const settle = settlers.shift();
      assert.ok(settle, "expected an unsettled send");
      settle(ok);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

/** A first value is shown and sent at once, then dropped once its command settles. */
test("shows an unconfirmed value until its command settles", async () => {
  const edits = createUnconfirmedEdits<string, number>();
  const channel = controlledSend<number>();

  edits.set("cue", 1, channel.send);

  assert.equal(edits.value("cue"), 1);
  assert.deepEqual(channel.sent, [1]);

  await channel.settleNext();

  assert.equal(edits.value("cue"), undefined);
});

/**
 * Values set while a command is in flight are sent one at a time in order, and the newest value
 * stays shown until the last command settles, so the reply to an older command cannot hide it.
 */
test("sends later values in order behind the in-flight command", async () => {
  const edits = createUnconfirmedEdits<string, number>();
  const channel = controlledSend<number>();

  edits.set("cue", 1, channel.send);
  edits.set("cue", 2, channel.send);
  edits.set("cue", 3, channel.send);

  assert.deepEqual(channel.sent, [1]);
  assert.equal(edits.value("cue"), 3);

  await channel.settleNext();

  assert.deepEqual(channel.sent, [1, 2]);
  assert.equal(edits.value("cue"), 3);

  await channel.settleNext();
  await channel.settleNext();

  assert.deepEqual(channel.sent, [1, 2, 3]);
  assert.equal(edits.value("cue"), undefined);
});

/** Each queued value keeps the send it was set with, so undo batch identity is not merged. */
test("keeps each queued value's own send", async () => {
  const edits = createUnconfirmedEdits<string, number>();
  const first = controlledSend<number>();
  const second = controlledSend<number>();

  edits.set("cue", 1, first.send);
  edits.set("cue", 2, second.send);
  await first.settleNext();

  assert.deepEqual(first.sent, [1]);
  assert.deepEqual(second.sent, [2]);
});

/** A rejected or failed command drops the entry, so readers fall back to the store value. */
test("drops the unconfirmed value when its command fails", async () => {
  const edits = createUnconfirmedEdits<string, number>();
  const channel = controlledSend<number>();

  edits.set("cue", 1, channel.send);
  await channel.settleNext(false);

  assert.equal(edits.value("cue"), undefined);
});

/** A send that throws synchronously, such as while disconnected, does not leave a stuck entry. */
test("drops the unconfirmed value when sending throws", async () => {
  const edits = createUnconfirmedEdits<string, number>();

  edits.set("cue", 1, () => {
    throw new Error("disconnected");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(edits.value("cue"), undefined);
});

/** Keys are independent: one key's in-flight command does not hold back another key's send. */
test("tracks keys independently", async () => {
  const edits = createUnconfirmedEdits<string, number>();
  const channel = controlledSend<number>();

  edits.set("a", 1, channel.send);
  edits.set("b", 2, channel.send);

  assert.deepEqual(channel.sent, [1, 2]);

  await channel.settleNext();

  assert.equal(edits.value("a"), undefined);
  assert.equal(edits.value("b"), 2);
});

/** Returns a send whose completion the test controls, for commands that carry no value. */
function controlledCommand() {
  const channel = controlledSend<null>();
  return { ...channel, send: () => channel.send(null) };
}

/**
 * Patches stay laid over whatever the engine value is now, so a change the engine made
 * elsewhere shows together with the unconfirmed edit, and each patch drops when it settles.
 */
test("lays unconfirmed patches over the current engine value", async () => {
  const patches = createUnconfirmedPatches<Record<string, number>>();
  const channel = controlledCommand();

  patches.add((value) => ({ ...value, a: 1 }), channel.send);
  patches.add((value) => ({ ...value, b: 2 }), channel.send);

  assert.deepEqual(patches.apply({}), { a: 1, b: 2 });
  assert.deepEqual(patches.apply({ c: 3 }), { a: 1, b: 2, c: 3 });

  await channel.settleNext();
  assert.deepEqual(patches.apply({ a: 1, c: 3 }), { a: 1, b: 2, c: 3 });

  await channel.settleNext(false);
  assert.deepEqual(patches.apply({ a: 1, c: 3 }), { a: 1, c: 3 });
});

/** Every patch's command is sent at once, in order, without waiting for earlier results. */
test("sends patch commands without queueing", () => {
  const patches = createUnconfirmedPatches<number>();
  const channel = controlledCommand();

  patches.add((value) => value + 1, channel.send);
  patches.add((value) => value * 2, channel.send);

  assert.equal(channel.sent.length, 2);
  assert.equal(patches.apply(1), 4);
});

/** A patch whose send throws synchronously is dropped rather than left applied. */
test("drops a patch when sending throws", async () => {
  const patches = createUnconfirmedPatches<number>();

  patches.add(
    (value) => value + 1,
    () => {
      throw new Error("disconnected");
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(patches.apply(1), 1);
});
