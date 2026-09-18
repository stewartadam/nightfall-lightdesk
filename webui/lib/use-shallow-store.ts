// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";

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
 * Subscribes to a Nanostore only while enabled and refreshes from the current
 * snapshot before reattaching after a disabled interval.
 */
export function useConditionalShallowStore<Value>(
  store: ShallowStore<Value>,
  enabled: Accessor<boolean>,
): Accessor<Value> {
  const [value, setValue] = createSignal<Value>(store.get());

  /** Owns the store listener for the current enabled interval. */
  createEffect(() => {
    if (!enabled()) return;

    setValue(() => store.get());
    const unsubscribe = store.listen((nextValue) => {
      setValue(() => nextValue);
    });
    onCleanup(unsubscribe);
  });

  return value;
}
