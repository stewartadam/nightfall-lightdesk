// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ReadableAtom } from "nanostores";
import { type Accessor, createRoot, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

type SharedEntry = {
  value: Accessor<unknown>;
  consumers: number;
  dispose: () => void;
};

const sharedEntries = new WeakMap<ReadableAtom<unknown>, SharedEntry>();

/** Creates the one reconciled Solid store that mirrors a Nanostore for all consumers. */
function createSharedEntry<Value>(store: ReadableAtom<Value>): SharedEntry {
  return createRoot((disposeRoot) => {
    // Listen before reading so lazy stores mount and report their live value.
    let setState: ((key: "value", value: unknown) => void) | undefined;
    const unsubscribe = store.listen((next) => {
      setState?.("value", reconcile(next as object));
    });
    const [state, set] = createStore({ value: store.get() as unknown });
    setState = set as typeof setState;
    return {
      value: () => state.value,
      consumers: 0,
      dispose: () => {
        unsubscribe();
        disposeRoot();
      },
    };
  });
}

/**
 * Subscribes to a Nanostore through one reconciled Solid store shared by every
 * mounted consumer.
 *
 * Behaves like `useStore` from `@nanostores/solid` (unchanged nested values
 * keep their identity, so keyed lists only update changed rows), but large
 * snapshot stores are wrapped and reconciled once per update instead of once
 * per component. The shared store is released when its last consumer unmounts.
 */
export function useSharedStore<Value>(
  store: ReadableAtom<Value>,
): Accessor<Value> {
  const key = store as ReadableAtom<unknown>;
  let entry = sharedEntries.get(key);
  if (!entry) {
    entry = createSharedEntry(store);
    sharedEntries.set(key, entry);
  }
  const owned = entry;
  owned.consumers += 1;
  onCleanup(() => {
    owned.consumers -= 1;
    if (owned.consumers === 0 && sharedEntries.get(key) === owned) {
      sharedEntries.delete(key);
      owned.dispose();
    }
  });
  return owned.value as Accessor<Value>;
}
