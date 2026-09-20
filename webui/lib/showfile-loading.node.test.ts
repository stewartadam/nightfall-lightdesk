// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

/** Replayed identity repairs persistence without resetting layouts; a new same-name load does reset them. */
test("confirmed showfile identity deduplicates resync replays", async () => {
  const storage = new Map<string, string>();
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  try {
    const { applyConfirmedShowfileChange, currentShowfileRevision } =
      await import("./showfile-loading");
    const revision = currentShowfileRevision.get();
    applyConfirmedShowfileChange("Tour", "first-load");
    assert.equal(currentShowfileRevision.get(), revision + 1);
    storage.clear();
    applyConfirmedShowfileChange("Tour", "first-load");
    assert.equal(storage.get("nightfall.currentShowfileName"), "Tour");
    assert.equal(currentShowfileRevision.get(), revision + 1);
    applyConfirmedShowfileChange("Tour", "second-load");
    assert.equal(currentShowfileRevision.get(), revision + 2);
  } finally {
    if (originalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
});
