// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createNotificationQueue,
  type NotificationEntry,
} from "./notification-queue";

/** Captures scheduled flushes and physical toast lifetimes without wall-clock timers. */
function harness() {
  const scheduled: (() => void)[] = [];
  const snapshots: NotificationEntry[][] = [];
  const visible = new Map<
    number,
    { entry: NotificationEntry; close: () => void; remove: () => void }
  >();
  let updates = 0;
  const queue = createNotificationQueue({
    schedule: (flush) => scheduled.push(flush),
    publishHistory: (entries) => snapshots.push(entries),
    render: (entry, removed, closing) => {
      visible.set(entry.id, {
        entry: { ...entry },
        close: closing,
        remove: () => {
          visible.delete(entry.id);
          removed();
        },
      });
      return {
        update: (current) => {
          updates += 1;
          visible.get(entry.id)!.entry = { ...current };
        },
        dismiss: closing,
      };
    },
  });
  return {
    queue,
    scheduled,
    snapshots,
    visible,
    updates: () => updates,
    flush: () => {
      const callbacks = scheduled.splice(0);
      for (const callback of callbacks) callback();
    },
    push: (message: string) =>
      queue.push({ level: "warning", message, actions: [], ttlMs: 5000 }),
  };
}

/** A 640-message burst publishes once, retains bounded history, and renders one counted summary. */
test("aggregates a large distinct burst before creating DOM", () => {
  const h = harness();
  for (let i = 0; i < 640; i += 1) h.push(`Warning ${i}`);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.visible.size, 0);
  assert.equal(h.snapshots.length, 0);
  h.flush();
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.snapshots[0].length, 100);
  assert.equal(h.snapshots[0][0].message, "Warning 639");
  assert.equal(h.visible.size, 1);
  assert.match(
    [...h.visible.values()][0].entry.message,
    /^640 additional notifications/,
  );
});

/** Duplicate counts update one visible node once per batch while history preserves the count. */
test("coalesces repeated messages and batches active updates", () => {
  const h = harness();
  h.push("Repeated");
  h.flush();
  for (let i = 1; i < 640; i += 1) h.push("Repeated");
  assert.equal(h.updates(), 0);
  h.flush();
  assert.equal(h.updates(), 1);
  assert.equal(h.visible.size, 1);
  assert.equal(h.snapshots[1].length, 1);
  assert.equal(h.snapshots[1][0].count, 640);
  assert.equal(h.snapshots[0][0].count, 1);
});

/** Dismissing toasts retain their physical slot until the exit animation actually removes them. */
test("limits visible toasts through dismissal and drains the short queue", () => {
  const h = harness();
  for (let i = 0; i < 10; i += 1) h.push(`Message ${i}`);
  h.flush();
  assert.equal(h.visible.size, 3);
  const first = [...h.visible.values()][0];
  first.close();
  h.flush();
  assert.equal(h.visible.size, 3);
  first.remove();
  h.flush();
  assert.equal(h.visible.size, 3);
  assert.equal([...h.visible.values()][2].entry.message, "Message 3");
});

/** Messages arriving while a summary is fading receive a new summary, preserving overflow counts. */
test("does not reuse a closing summary", () => {
  const h = harness();
  for (let i = 0; i < 20; i += 1) h.push(`First ${i}`);
  h.flush();
  const first = [...h.visible.values()][0];
  first.close();
  for (let i = 0; i < 30; i += 1) h.push(`Second ${i}`);
  h.flush();
  first.remove();
  h.flush();
  assert.equal(h.visible.size, 1);
  assert.match([...h.visible.values()][0].entry.message, /^30 additional/);
});

/** Clearing history cancels its pending publication but allows genuinely new messages to appear. */
test("clear history does not resurrect buffered notifications", () => {
  const h = harness();
  h.push("Old");
  h.queue.clearHistory();
  h.flush();
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.snapshots[0].length, 0);
  h.push("Old");
  h.flush();
  assert.equal(h.snapshots[1].length, 1);
  assert.equal(h.snapshots[1][0].count, 1);
});

/** Action overflow stays executable in bounded history and cannot execute twice after dismissal. */
test("retains distinct actions through ordinary floods and executes them once", () => {
  const h = harness();
  let calls = 0;
  for (let i = 0; i < 12; i += 1)
    h.queue.push({
      level: "error",
      message: "Retry failed operation",
      ttlMs: -1,
      actions: [
        {
          label: "Retry",
          onClick: () => {
            calls += 1;
          },
        },
      ],
    });
  for (let i = 0; i < 640; i += 1) h.push(`Warning ${i}`);
  h.flush();
  const actions = h.snapshots[0].filter((entry) => entry.actions.length > 0);
  assert.equal(actions.length, 12);
  assert.equal(h.visible.size, 3);
  const overflowed = actions[0];
  h.queue.runAction(overflowed.id, 0);
  h.queue.runAction(overflowed.id, 0);
  h.flush();
  assert.equal(calls, 1);
  assert.equal(
    h.snapshots[1].find((entry) => entry.id === overflowed.id)?.actions.length,
    0,
  );
});

/** Reusable details actions do not dismiss their notification or become disabled. */
test("supports nondismissing actions and propagates error severity into summaries", () => {
  const h = harness();
  let calls = 0;
  h.queue.push({
    level: "info",
    message: "Details",
    ttlMs: -1,
    actions: [
      {
        label: "Details",
        dismissOnClick: false,
        onClick: () => {
          calls += 1;
        },
      },
    ],
  });
  h.flush();
  const id = h.snapshots[0][0].id;
  h.queue.runAction(id, 0);
  h.queue.runAction(id, 0);
  assert.equal(calls, 2);
  for (let i = 0; i < 20; i += 1) h.push(`Warning ${i}`);
  h.queue.push({
    level: "error",
    message: "Failure",
    ttlMs: 5000,
    actions: [],
  });
  h.flush();
  assert.equal(
    [...h.visible.values()].find(
      ({ entry }) => entry.title === "Notification summary",
    )?.entry.level,
    "error",
  );
});
