// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Store, StoreValue } from "nanostores";
import { type Accessor, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

/**
 * Subscribes a component to a Nanostore and returns its value as a Solid
 * accessor.
 *
 * Each update is reconciled into a Solid store, so nested values that did not
 * change keep their identity and keyed lists only re-render changed rows. The
 * subscription ends when the calling owner is disposed.
 *
 * This is the app's only bridge between Nanostores and Solid's store API, so a
 * Solid upgrade changes this file instead of every consumer. For large
 * snapshot stores read by many components, prefer `useSharedStore` or
 * `useShallowStore`.
 */
export function useStore<
  SomeStore extends Store,
  Value extends StoreValue<SomeStore>,
>(store: SomeStore): Accessor<Value> {
  // A temporary listener mounts lazy stores (onMount) before the first read,
  // so the initial snapshot is the live value rather than the idle default.
  const releaseMount = store.listen(() => {});
  const [state, setState] = createStore({ value: store.get() as Value });
  const unsubscribe = store.subscribe((next) => {
    setState("value", reconcile(next as Value));
  });
  onCleanup(unsubscribe);
  releaseMount();
  return () => state.value;
}
