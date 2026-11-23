// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";
import { createEffect } from "./solid-compat";

type ShallowStore<Value> = {
  get: () => Value;
  listen: (listener: (value: Value) => void) => () => void;
};

/**
 * Subscribes to a Nanostore through a shallow Solid signal without recursively
 * reconciling nested snapshot payloads.
 */
export function useShallowStore<Value>(
  store: ShallowStore<Value>,
): Accessor<Value> {
  const [value, setValue] = createSignal<Value>(store.get());
  const unsubscribe = store.listen((nextValue) => {
    setValue(() => nextValue);
  });
  onCleanup(unsubscribe);
  return value;
}

/**
 * Subscribes to a Nanostore only while enabled and keeps the last value seen
 * while disabled.
 *
 * The value is a memo that reads the live snapshot whenever `enabled` turns
 * true, so readers never observe the snapshot left over from before the
 * disabled interval. The listener only signals that the store changed.
 */
export function useConditionalShallowStore<Value>(
  store: ShallowStore<Value>,
  enabled: Accessor<boolean>,
): Accessor<Value> {
  const [changes, notifyChange] = createSignal(undefined, { equals: false });

  /** Owns the store listener for the current enabled interval. */
  createEffect(enabled, (active) => {
    if (!active) return;
    const unsubscribe = store.listen(() => notifyChange());
    // Catches a change made between the memo's read and this listener.
    notifyChange();
    return unsubscribe;
  });

  /** Reads the live snapshot while enabled and holds the last one otherwise. */
  return createMemo((previous) => {
    changes();
    return enabled() ? store.get() : previous;
  }, store.get());
}
