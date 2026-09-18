// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { useTestStorageEngine } from "@nanostores/persistent";
import type { DockviewApi } from "dockview";
import {
  activeLayoutId,
  clearLayoutSessions,
  getLayoutSession,
  reconcileLayoutSessions,
} from "../state/layout-switcher";
import { activateStoredLayout } from "./layout-activation";
import {
  clearAllLayoutStorage,
  getActiveStoredLayoutId,
  getStoredLayout,
  storeCurrentLayout,
} from "./layoutStorage";

/** Resets persistence and in-memory layout arrangements between independent scenarios. */
beforeEach(() => {
  useTestStorageEngine();
  clearAllLayoutStorage();
  clearLayoutSessions();
});

/** Creates a mutable Dockview stand-in that can simulate a partially failed restore. */
function workspace() {
  let current = { grid: "a" };
  let fail = false;
  const api = {
    panels: [],
    toJSON: () => current,
    fromJSON: (layout: typeof current) => {
      current = layout;
      if (fail) {
        fail = false;
        throw new Error("Restore failed");
      }
    },
  } as unknown as DockviewApi;
  const a = storeCurrentLayout(api, "A")!;
  current = { grid: "b" };
  const b = storeCurrentLayout(api, "B")!;
  return {
    api,
    a,
    b,
    /** Simulates a user rearranging panels. */
    customize: () => {
      current = { grid: "customized" };
    },
    /** Returns the currently rendered arrangement. */
    current: () => current,
    /** Makes the next restore fail after mutating Dockview. */
    failNext: () => {
      fail = true;
    },
  };
}

/** Layout recalls retain working arrangements while reset leaves the saved snapshots immutable. */
test("switches between working copies and resets only the requested layout", () => {
  const w = workspace();
  assert.equal(activateStoredLayout(w.api, w.a.id), true);
  w.customize();
  activateStoredLayout(w.api, w.b.id);
  activateStoredLayout(w.api, w.a.id);
  assert.deepEqual(w.current(), { grid: "customized" });
  assert.deepEqual(getStoredLayout(w.a.id)?.layout, { grid: "a" });
  activateStoredLayout(w.api, w.a.id, { reset: true });
  assert.deepEqual(w.current(), { grid: "a" });
  activateStoredLayout(w.api, w.b.id);
  activateStoredLayout(w.api, w.a.id);
  assert.deepEqual(w.current(), { grid: "a" });
});

/** Failed recalls restore the outgoing arrangement and keep the active layout identity. */
test("rolls back a failed restore without changing active selection", () => {
  const w = workspace();
  activateStoredLayout(w.api, w.a.id);
  w.customize();
  w.failNext();
  assert.equal(activateStoredLayout(w.api, w.b.id), false);
  assert.deepEqual(w.current(), { grid: "customized" });
  assert.equal(activeLayoutId.get(), w.a.id);
  assert.equal(getActiveStoredLayoutId(), w.a.id);
});

/** Layout recalls preserve outgoing edits and selecting the active layout leaves its view intact. */
test("layout recalls preserve the outgoing arrangement and active layout clicks are inert", () => {
  const w = workspace();
  activateStoredLayout(w.api, w.a.id);
  w.customize();
  activateStoredLayout(w.api, w.a.id);
  assert.deepEqual(w.current(), { grid: "customized" });
  activateStoredLayout(w.api, w.b.id);
  assert.equal(activeLayoutId.get(), w.b.id);
  activateStoredLayout(w.api, w.a.id);
  assert.deepEqual(w.current(), { grid: "customized" });
});

/** Reordering retains working copies; deletion and showfile changes discard them. */
test("invalidates working copies by layout identity and showfile context", () => {
  const w = workspace();
  activateStoredLayout(w.api, w.a.id);
  w.customize();
  activateStoredLayout(w.api, w.b.id);
  reconcileLayoutSessions([w.b.id, w.a.id]);
  assert.deepEqual(getLayoutSession(w.a.id)?.layout, { grid: "customized" });
  reconcileLayoutSessions([w.b.id]);
  assert.equal(getLayoutSession(w.a.id), undefined);
  assert.equal(activeLayoutId.get(), w.b.id);
  clearLayoutSessions();
  assert.equal(getLayoutSession(w.b.id), undefined);
});

/** Adopting a new layout records the current arrangement without deserializing or replacing panels. */
test("adopts the current workspace without restoring the saved snapshot", () => {
  const w = workspace();
  w.customize();
  w.failNext();
  assert.equal(
    activateStoredLayout(w.api, w.a.id, { adoptCurrent: true }),
    true,
  );
  assert.deepEqual(w.current(), { grid: "customized" });
  assert.deepEqual(getLayoutSession(w.a.id)?.layout, { grid: "customized" });
  assert.equal(activeLayoutId.get(), w.a.id);
});
