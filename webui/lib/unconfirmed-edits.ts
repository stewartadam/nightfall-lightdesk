// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createSignal, type Setter } from "solid-js";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

/** Sends one value to the engine and settles once its command has a terminal result. */
export type UnconfirmedEditSend<V> = (value: V) => Promise<unknown>;

/**
 * Edits the user made that the engine has not confirmed yet, keyed by the edited object.
 * Callers show {@link UnconfirmedEdits.value} in place of the store value while it is set, and
 * never write the engine-owned store themselves.
 */
export interface UnconfirmedEdits<K, V> {
  /** Returns the newest unconfirmed value for a key, or undefined. Reactive per key. */
  value(key: K): V | undefined;
  /**
   * Records a new value for a key and sends it. While an earlier command for the same key is in
   * flight, the send waits in order behind it, so the engine applies the key's edits in the
   * order the user made them and each keeps its own command (and undo step).
   */
  set(key: K, value: V, send: UnconfirmedEditSend<V>): void;
}

/** One value waiting to be sent. */
interface QueuedSend<V> {
  value: V;
  send: UnconfirmedEditSend<V>;
}

/** Bookkeeping for one key with an unconfirmed value. */
interface UnconfirmedEntry<V> {
  /** Newest value set for the key, shown in place of the store value. */
  value: V;
  /** Sends waiting behind the in-flight command, oldest first. */
  queue: QueuedSend<V>[];
}

/**
 * Tracks unconfirmed edits to engine-owned state, shown in place of the store value.
 *
 * The engine publishes the state a command produced no later than that command's
 * `CommandResult`, so an entry is dropped as soon as its last command settles: on success the
 * store already holds the engine's answer, and on failure the store never changed, so dropping
 * the entry is the rollback. Replies to older commands never replace a newer edit, because the
 * entry stays until the newest value's command settles. At most one command per key is in
 * flight.
 */
export function createUnconfirmedEdits<K, V>(): UnconfirmedEdits<K, V> {
  const entries = new Map<K, UnconfirmedEntry<V>>();
  const revisions = new Map<K, [Accessor<number>, Setter<number>]>();

  /** Returns the per-key revision signal, creating it on first use. */
  const revisionSignal = (key: K) => {
    let signal = revisions.get(key);
    if (!signal) {
      signal = createSignal(0);
      revisions.set(key, signal);
    }
    return signal;
  };

  /** Notifies readers of one key that its unconfirmed value changed. */
  const notify = (key: K) => {
    const [, setRevision] = revisionSignal(key);
    setRevision((current) => current + 1);
  };

  /** Sends the oldest queued value for a key, then the next, dropping the entry when drained. */
  const sendNext = (key: K, entry: UnconfirmedEntry<V>) => {
    const next = entry.queue.shift();
    if (!next) {
      entries.delete(key);
      notify(key);
      return;
    }
    let sent: Promise<unknown>;
    try {
      sent = next.send(next.value);
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent
      .catch((error) => {
        log.warn("Unconfirmed edit command did not complete", error);
      })
      .then(() => sendNext(key, entry));
  };

  return {
    value(key) {
      revisionSignal(key)[0]();
      return entries.get(key)?.value;
    },
    set(key, value, send) {
      const existing = entries.get(key);
      if (existing) {
        // An entry only exists while one of its commands is in flight, so this send waits.
        existing.value = value;
        existing.queue.push({ value, send });
        notify(key);
        return;
      }
      const entry: UnconfirmedEntry<V> = { value, queue: [{ value, send }] };
      entries.set(key, entry);
      notify(key);
      sendNext(key, entry);
    },
  };
}
