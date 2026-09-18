// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  setPersistentEngine,
  useTestStorageEngine,
} from "@nanostores/persistent";
import { bestEffortPersistentAtom } from "./best-effort-persistent-atom";

/**
 * Builds a storage engine that can read existing keys but rejects all writes.
 */
function createWriteFailingStorage(
  values: Record<string, string> = {},
): Record<string, string> {
  return new Proxy(values, {
    deleteProperty() {
      throw new Error("forced storage delete failure");
    },
    set() {
      throw new Error("forced storage write failure");
    },
  });
}

afterEach(() => {
  useTestStorageEngine();
});

test("best-effort persistent atom updates memory when storage writes fail", () => {
  const errors: unknown[] = [];
  setPersistentEngine(createWriteFailingStorage(), {
    addEventListener() {},
    removeEventListener() {},
  });

  const store = bestEffortPersistentAtom("preference", "initial", {
    decode: (value) => value,
    encode: (value) => value,
    onSetError: (error) => errors.push(error),
  });

  store.set("updated");

  assert.equal(store.get(), "updated");
  assert.equal(errors.length, 1);
});
