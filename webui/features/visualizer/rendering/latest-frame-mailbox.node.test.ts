// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LatestFrameMailbox } from "./latest-frame-mailbox";

/** Allows acknowledgement handlers to drain before observing the next submission. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A stalled worker receives the latest blackout next, never a backlog of older looks. */
test("lighting mailbox coalesces pending frames and cancels them on disposal", async () => {
  const sent: { intensity: number }[] = [];
  let acknowledge!: () => void;
  const mailbox = new LatestFrameMailbox<{ intensity: number }>(
    (value) => {
      sent.push(value);
      return new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
    },
    (error) => assert.fail(String(error)),
  );
  mailbox.publish({ intensity: 1 });
  assert.equal(mailbox.busy, true);
  for (let i = 0; i < 1000; i++) mailbox.publish({ intensity: 0.5 });
  mailbox.publish({ intensity: 0 });
  assert.equal(sent.length, 1);
  acknowledge();
  await settle();
  assert.deepEqual(sent, [{ intensity: 1 }, { intensity: 0 }]);
  mailbox.publish({ intensity: 1 });
  mailbox.dispose();
  acknowledge();
  await settle();
  assert.equal(sent.length, 2);
  assert.equal(mailbox.busy, false);
});

/** Pausing and failed delivery cannot leave obsolete lighting queued for resume. */
test("lighting mailbox clears unsent frames and recovers after rejection", async () => {
  let reject!: (error: Error) => void;
  const sent: object[] = [];
  const errors: unknown[] = [];
  const mailbox = new LatestFrameMailbox<object>(
    (value) => {
      sent.push(value);
      return new Promise((_, fail) => {
        reject = fail;
      });
    },
    (error) => errors.push(error),
  );
  mailbox.publish({ frame: 1 });
  mailbox.publish({ frame: 2 });
  mailbox.clear();
  reject(new Error("disconnected"));
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(errors.length, 1);
  mailbox.publish({ frame: 3 });
  assert.deepEqual(sent, [{ frame: 1 }, { frame: 3 }]);
  mailbox.dispose();
});
