// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type BackgroundMountScheduler,
  createBackgroundMountQueue,
} from "./background-panel-mounts";

/** Scheduler whose frames and idle periods run only when the test flushes them. */
function manualScheduler() {
  let pending: Array<() => void> = [];
  let blocked = false;
  const listeners = new Set<() => void>();
  const scheduler: BackgroundMountScheduler = {
    afterFrame: (callback) => pending.push(callback),
    whenIdle: (callback) => pending.push(callback),
    isBlocked: () => blocked,
    onBlockedChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    scheduler,
    /** Runs every frame and idle callback queued so far. */
    flush() {
      const callbacks = pending;
      pending = [];
      for (const callback of callbacks) callback();
    },
    /** Changes whether a showfile load is settling and notifies the queue. */
    setBlocked(value: boolean) {
      blocked = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Verifies queued panels mount one per idle period, in order, after a frame. */
test("background mounts run one at a time after a frame and an idle period", () => {
  const clock = manualScheduler();
  const queue = createBackgroundMountQueue(clock.scheduler);
  const mounted: string[] = [];
  queue.schedule(() => mounted.push("patch"));
  queue.schedule(() => mounted.push("fixtures"));

  assert.deepEqual(mounted, [], "nothing mounts synchronously");
  clock.flush(); // frame
  clock.flush(); // idle
  assert.deepEqual(mounted, ["patch"]);
  clock.flush();
  clock.flush();
  assert.deepEqual(mounted, ["patch", "fixtures"]);
});

/** Verifies a cancelled panel, such as one opened by the user first, never mounts from the queue. */
test("cancelled background mounts are skipped", () => {
  const clock = manualScheduler();
  const queue = createBackgroundMountQueue(clock.scheduler);
  const mounted: string[] = [];
  const cancel = queue.schedule(() => mounted.push("patch"));
  queue.schedule(() => mounted.push("fixtures"));
  cancel();

  clock.flush();
  clock.flush();
  assert.deepEqual(mounted, ["fixtures"]);
});

/** Verifies the queue waits while a showfile load is settling and resumes once it ends. */
test("background mounts wait for a showfile load to settle", () => {
  const clock = manualScheduler();
  clock.setBlocked(true);
  const queue = createBackgroundMountQueue(clock.scheduler);
  const mounted: string[] = [];
  queue.schedule(() => mounted.push("patch"));

  clock.flush();
  clock.flush();
  assert.deepEqual(mounted, [], "blocked while the load settles");

  clock.setBlocked(false);
  clock.flush();
  clock.flush();
  assert.deepEqual(mounted, ["patch"]);
});
