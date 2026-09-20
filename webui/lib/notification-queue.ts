// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type ToastLevel = "info" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Keeps the action reusable and its toast open when false. */
  dismissOnClick?: boolean;
}

export interface NotificationEntry {
  id: number;
  level: ToastLevel;
  message: string;
  createdAt: number;
  count: number;
  actions: readonly ToastAction[];
  ttlMs: number;
  title?: string;
  /** Renderer-specific icon identity, also used to distinguish duplicate messages. */
  icon?: unknown;
}

export interface NotificationHandle {
  update: (entry: NotificationEntry) => void;
  dismiss: () => void;
}

interface NotificationQueueOptions {
  render: (
    entry: NotificationEntry,
    onDismiss: () => void,
    onClosing: () => void,
  ) => NotificationHandle;
  publishHistory: (entries: NotificationEntry[]) => void;
  schedule: (flush: () => void) => void;
}

const VISIBLE_LIMIT = 3;
const PENDING_LIMIT = 10;
const HISTORY_LIMIT = 100;
const severity: Record<ToastLevel, number> = {
  success: 0,
  info: 1,
  warning: 2,
  error: 3,
};

/** Bounds presentation and history work independently of the notification arrival rate. */
export function createNotificationQueue(options: NotificationQueueOptions) {
  let nextId = 1;
  let scheduled = false;
  let historyDirty = false;
  let history: NotificationEntry[] = [];
  let pending: NotificationEntry[] = [];
  const active = new Map<
    number,
    { entry: NotificationEntry; handle: NotificationHandle }
  >();
  const dirty = new Set<number>();
  const closing = new Set<number>();
  let overflow: NotificationEntry | undefined;

  /** Schedules at most one publication and bounded DOM update per batch interval. */
  function requestFlush() {
    if (scheduled) return;
    scheduled = true;
    options.schedule(flush);
  }

  /** Counts suppressed presentations without allocating a backlog of DOM work. */
  function summarize(entry: NotificationEntry) {
    overflow ??= {
      id: nextId++,
      level: entry.level,
      message: "",
      createdAt: Date.now(),
      count: 0,
      actions: [],
      ttlMs: 5000,
      title: "Notification summary",
    };
    overflow.count += entry.count;
    if (severity[entry.level] > severity[overflow.level])
      overflow.level = entry.level;
    overflow.message = `${overflow.count} additional notifications. Open notification history to see recent messages and actions.`;
    dirty.add(overflow.id);
  }

  /** Publishes one bounded history snapshot and fills only physically available toast slots. */
  function flush() {
    scheduled = false;
    if (historyDirty) {
      historyDirty = false;
      options.publishHistory(history.map((entry) => ({ ...entry })));
    }
    for (const id of dirty) {
      const visible = active.get(id);
      if (visible) visible.handle.update(visible.entry);
    }
    dirty.clear();
    while (active.size < VISIBLE_LIMIT) {
      const entry =
        overflow && !active.has(overflow.id) ? overflow : pending.shift();
      if (!entry) break;
      const handle = options.render(
        entry,
        () => {
          active.delete(entry.id);
          closing.delete(entry.id);
          if (overflow?.id === entry.id) overflow = undefined;
          requestFlush();
        },
        () => {
          closing.add(entry.id);
          if (overflow?.id === entry.id) overflow = undefined;
        },
      );
      active.set(entry.id, { entry, handle });
    }
  }

  /** Enqueues a notification, coalescing only non-actionable messages with identical presentation. */
  function push(input: Omit<NotificationEntry, "id" | "count" | "createdAt">) {
    const duplicate =
      input.actions.length === 0
        ? [
            ...pending,
            ...Array.from(active.values(), ({ entry }) => entry),
          ].find(
            (entry) =>
              !closing.has(entry.id) &&
              history.includes(entry) &&
              entry !== overflow &&
              entry.actions.length === 0 &&
              entry.level === input.level &&
              entry.message === input.message &&
              entry.title === input.title &&
              entry.icon === input.icon &&
              entry.ttlMs === input.ttlMs,
          )
        : undefined;
    if (duplicate) {
      duplicate.count += 1;
      duplicate.createdAt = Date.now();
      historyDirty = true;
      dirty.add(duplicate.id);
      requestFlush();
      return;
    }
    const entry = { ...input, id: nextId++, count: 1, createdAt: Date.now() };
    history.unshift(entry);
    if (history.length > HISTORY_LIMIT) {
      // Prefer retaining actions when ordinary message floods fill recent history.
      let index = history.length - 1;
      while (index >= 0 && history[index].actions.length > 0) index -= 1;
      if (index < 0) index = history.length - 1;
      history.splice(index, 1);
    }
    historyDirty = true;
    if (overflow && entry.actions.length === 0) {
      summarize(entry);
    } else if (pending.length < PENDING_LIMIT) {
      pending.push(entry);
    } else {
      // Collapse ordinary pending messages; action buttons stay reachable in history.
      const retained: NotificationEntry[] = [];
      for (const queued of pending) {
        if (queued.actions.length > 0) retained.push(queued);
        else summarize(queued);
      }
      pending = retained;
      if (entry.actions.length > 0 && pending.length < PENDING_LIMIT)
        pending.push(entry);
      else summarize(entry);
    }
    requestFlush();
  }

  /** Executes an action once for dismissing notifications, regardless of its UI entry point. */
  function runAction(id: number, index: number) {
    const entry =
      active.get(id)?.entry ??
      pending.find((item) => item.id === id) ??
      history.find((item) => item.id === id);
    const action = entry?.actions[index];
    if (!entry || !action) return;
    if (action.dismissOnClick !== false) {
      entry.actions = [];
      pending = pending.filter((item) => item.id !== id);
      active.get(id)?.handle.dismiss();
      historyDirty = true;
      requestFlush();
    }
    action.onClick();
  }

  /** Clears both published and not-yet-published history without dismissing current toasts. */
  function clearHistory() {
    history = [];
    historyDirty = false;
    options.publishHistory([]);
  }

  return { push, runAction, clearHistory };
}
