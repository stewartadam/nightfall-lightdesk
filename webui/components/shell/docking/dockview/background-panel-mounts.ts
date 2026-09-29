// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { requestIdleCallbackSafe } from "../../../../lib/idle-callback";
import { showfileTransition } from "../../../../state/showfile-transition";

/** Scheduling hooks, injectable so tests can drive the queue step by step. */
export type BackgroundMountScheduler = {
  /** Runs a callback after the next painted frame. */
  afterFrame: (callback: () => void) => void;
  /** Runs a callback once the main thread is idle. */
  whenIdle: (callback: () => void) => void;
  /** Returns whether a showfile load is still settling its visible panels. */
  isBlocked: () => boolean;
  /** Calls the listener whenever the blocked state may have changed. */
  onBlockedChange: (listener: () => void) => () => void;
};

/** Longest wait for an idle period before a queued panel mounts anyway. */
const IDLE_TIMEOUT_MS = 1_000;

/** Browser scheduler: waits for a painted frame and then an idle period. */
const browserScheduler: BackgroundMountScheduler = {
  afterFrame: (callback) =>
    requestAnimationFrame(() => requestAnimationFrame(callback)),
  whenIdle: (callback) =>
    requestIdleCallbackSafe(callback, { timeout: IDLE_TIMEOUT_MS }),
  isBlocked: () => showfileTransition.get() !== null,
  onBlockedChange: (listener) => showfileTransition.listen(listener),
};

/**
 * Creates a queue that mounts hidden panels one at a time in the background.
 *
 * Each mount waits until no showfile load is settling, then for a painted
 * frame and an idle period, so visible panels finish first and each hidden
 * panel mounts in its own task instead of one long startup task.
 */
export function createBackgroundMountQueue(
  scheduler: BackgroundMountScheduler = browserScheduler,
) {
  const queue: Array<() => void> = [];
  let draining = false;
  let unsubscribeBlocked: (() => void) | undefined;

  /** Mounts the next queued panel and schedules the one after it. */
  const drain = () => {
    if (scheduler.isBlocked()) {
      draining = false;
      unsubscribeBlocked ??= scheduler.onBlockedChange(() => {
        if (scheduler.isBlocked()) return;
        unsubscribeBlocked?.();
        unsubscribeBlocked = undefined;
        start();
      });
      return;
    }
    const mount = queue.shift();
    if (!mount) {
      draining = false;
      return;
    }
    mount();
    scheduler.afterFrame(() => scheduler.whenIdle(drain));
  };

  /** Starts draining after the current frame unless a drain is already pending. */
  const start = () => {
    if (draining || queue.length === 0) return;
    draining = true;
    scheduler.afterFrame(() => scheduler.whenIdle(drain));
  };

  return {
    /**
     * Queues a panel mount and returns a function that removes it again, for
     * panels that are shown or disposed before their turn.
     */
    schedule(mount: () => void): () => void {
      queue.push(mount);
      start();
      return () => {
        const index = queue.indexOf(mount);
        if (index !== -1) queue.splice(index, 1);
      };
    },
  };
}

/** App-wide queue shared by every dock workspace. */
export const backgroundPanelMounts = createBackgroundMountQueue();
