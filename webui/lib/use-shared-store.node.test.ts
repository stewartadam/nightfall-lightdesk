// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { atom } from "nanostores";
import { createRoot } from "solid-js";
import { useSharedStore } from "./use-shared-store";

type Row = { uid: string; label: string };

/** Verifies consumers read one shared value that follows store updates. */
test("useSharedStore shares one reconciled value across consumers", () => {
  const store = atom<Record<string, Row>>({
    a: { uid: "a", label: "A" },
    b: { uid: "b", label: "B" },
  });

  createRoot((dispose) => {
    const first = useSharedStore(store);
    const second = useSharedStore(store);
    assert.equal(first(), second());

    store.set({
      a: { uid: "a", label: "A2" },
      b: { uid: "b", label: "B" },
    });

    assert.equal(first().a.label, "A2");
    assert.equal(second().a.label, "A2");
    assert.equal(first(), second());
    dispose();
  });
});

/** Verifies the shared subscription ends with its last consumer and restarts from the live value. */
test("useSharedStore releases its listener after the last consumer unmounts", () => {
  const store = atom({ label: "initial" });

  const disposeFirst = createRoot((dispose) => {
    useSharedStore(store);
    return dispose;
  });
  const disposeSecond = createRoot((dispose) => {
    useSharedStore(store);
    return dispose;
  });
  assert.equal(store.lc, 1, "consumers share one listener");

  disposeFirst();
  assert.equal(store.lc, 1, "a remaining consumer keeps the listener");
  disposeSecond();
  assert.equal(store.lc, 0);

  store.set({ label: "changed while unmounted" });
  createRoot((dispose) => {
    const value = useSharedStore(store);
    assert.equal(value().label, "changed while unmounted");
    dispose();
  });
});
