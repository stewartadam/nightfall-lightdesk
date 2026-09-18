// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { action } from "@nanostores/logger";
import type { StoreValue, WritableStore } from "nanostores";

type SetAction = (value: unknown) => void;
type SetKeyAction = (key: any, value: any) => void;
type StoreWithSetKey = WritableStore & {
  setKey: (key: any, value: any) => void;
};

const setActions = new WeakMap<WritableStore, Map<string, SetAction>>();
const setKeyActions = new WeakMap<StoreWithSetKey, Map<string, SetKeyAction>>();

/** Get or create the cached action wrapper for replacing an entire store value. */
function getSetAction<Store extends WritableStore>(
  store: Store,
  actionName: string,
): SetAction {
  let actions = setActions.get(store);
  if (!actions) {
    actions = new Map();
    setActions.set(store, actions);
  }

  let setAction = actions.get(actionName);
  if (!setAction) {
    setAction = action(store, actionName, ($store, value: unknown) => {
      $store.set(value as StoreValue<Store>);
    }) as SetAction;
    actions.set(actionName, setAction);
  }

  return setAction;
}

/** Get or create the cached action wrapper for replacing one map/deep-map key. */
function getSetKeyAction<Store extends StoreWithSetKey>(
  store: Store,
  actionName: string,
): SetKeyAction {
  let actions = setKeyActions.get(store);
  if (!actions) {
    actions = new Map();
    setKeyActions.set(store, actions);
  }

  let setKeyAction = actions.get(actionName);
  if (!setKeyAction) {
    setKeyAction = action(store, actionName, ($store, key: any, value: any) => {
      $store.setKey(key, value);
    }) as SetKeyAction;
    actions.set(actionName, setKeyAction);
  }

  return setKeyAction;
}

/** Replace a Nanostore value with an action name visible to @nanostores/logger. */
export function setStoreAction<Store extends WritableStore>(
  store: Store,
  actionName: string,
  value: StoreValue<Store>,
): void {
  getSetAction(store, actionName)(value);
}

/** Replace a map or deep-map key with an action name visible to @nanostores/logger. */
export function setStoreKeyAction<Store extends StoreWithSetKey>(
  store: Store,
  actionName: string,
  key: any,
  value: any,
): void {
  getSetKeyAction(store, actionName)(key, value);
}
