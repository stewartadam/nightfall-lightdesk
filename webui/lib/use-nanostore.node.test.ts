// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { atom, onMount } from "nanostores";
import { createRoot } from "solid-js";
import { useStore } from "./use-nanostore";

type Row = { uid: string; label: string };

/**
 * Verifies the accessor follows store updates. Node resolves Solid's server
 * build, which doesn't keep identities through reconcile, so identity is left
 * to the browser tests.
 */
test("useStore follows store updates", () => {
  const store = atom<Record<string, Row>>({
    a: { uid: "a", label: "A" },
    b: { uid: "b", label: "B" },
  });

  createRoot((dispose) => {
    const value = useStore(store);

    store.set({
      a: { uid: "a", label: "A2" },
      b: { uid: "b", label: "B" },
    });

    assert.equal(value().a.label, "A2");
    assert.equal(value().b.label, "B");
    dispose();
  });
});

/** Verifies a lazy store is mounted before the first read and released with the owner. */
test("useStore reads a lazy store's live value and unsubscribes on cleanup", () => {
  const store = atom("idle");
  onMount(store, () => {
    store.set("live");
  });

  createRoot((dispose) => {
    const value = useStore(store);
    assert.equal(value(), "live");
    assert.equal(store.lc, 1, "one subscription while mounted");
    dispose();
  });
  assert.equal(store.lc, 0);
});
