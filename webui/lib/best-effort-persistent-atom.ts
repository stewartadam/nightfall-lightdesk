// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { persistentAtom } from "@nanostores/persistent";
import { atom, type WritableAtom } from "nanostores";

interface BestEffortPersistentAtomOptions<Value> {
  decode: (value: string) => Value;
  encode: (value: Value) => string | undefined;
  onSetError?: (error: unknown) => void;
}

/**
 * Creates a nanostore that updates in memory before attempting persistence.
 */
export function bestEffortPersistentAtom<Value>(
  name: string,
  initial: Value,
  options: BestEffortPersistentAtomOptions<Value>,
): WritableAtom<Value> {
  const persistentStore = persistentAtom<Value>(name, initial, {
    decode: options.decode,
    encode: options.encode,
  });
  const memoryStore = atom<Value>(persistentStore.get());
  const setMemoryValue = memoryStore.set.bind(memoryStore);

  persistentStore.subscribe((value) => {
    setMemoryValue(value);
  });

  memoryStore.set = (value) => {
    setMemoryValue(value);
    try {
      persistentStore.set(value);
    } catch (error) {
      options.onSetError?.(error);
    }
  };

  return memoryStore;
}
