// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { useTestStorageEngine } from "@nanostores/persistent";
import { cloneSerializedLayout } from "../lib/dockview-layout";
import {
  clearAllLayoutStorage,
  replaceStoredLayoutsFromShowfile,
} from "../lib/layoutStorage";
import {
  acknowledgeLayoutResize,
  clearLayoutSessions,
  getLayoutResizeRevision,
  modifiedLayoutIds,
  rememberLayoutResize,
  rememberLayoutSession,
} from "./layout-switcher";

/** Isolates saved layouts and transient resize histories between scenarios. */
beforeEach(() => {
  useTestStorageEngine();
  clearAllLayoutStorage();
  clearLayoutSessions();
});

/** Creates a normalized saved snapshot with controllable grid geometry. */
function fixture() {
  const source = {
    id: "saved",
    name: "Saved",
    shownInSwitcher: true,
    createdAt: 1,
    updatedAt: 1,
    version: 2,
    panels: [],
    layout: {
      grid: {
        width: 1000,
        height: 700,
        root: { type: "branch", data: [], size: 700 },
      },
      panels: {},
    },
  };
  const saved = {
    ...source,
    ...cloneSerializedLayout(source),
  } as typeof source;
  replaceStoredLayoutsFromShowfile([saved]);
  rememberLayoutSession(saved.id, saved, saved);
  return saved;
}

/** Automatic dimensions neither mark a clean arrangement nor erase a genuine divider edit. */
test("automatic sizing and explicit sizing have independent dirty state", () => {
  const saved = fixture();
  const auto = structuredClone(saved);
  auto.layout.grid.width = 1200;
  rememberLayoutSession(saved.id, auto);
  assert.deepEqual(modifiedLayoutIds.get(), []);
  const manual = structuredClone(auto);
  manual.layout.grid.root.size = 650;
  rememberLayoutResize(saved.id, auto, manual);
  assert.deepEqual(modifiedLayoutIds.get(), [saved.id]);
  const later = structuredClone(manual);
  later.layout.grid.width = 1400;
  rememberLayoutSession(saved.id, later);
  assert.deepEqual(modifiedLayoutIds.get(), [saved.id]);
  rememberLayoutResize(saved.id, manual, auto);
  assert.deepEqual(modifiedLayoutIds.get(), []);
});

/** Save acknowledgements clear only their captured resize, and Revert clears the complete resize history. */
test("delayed saves cannot erase newer resize gestures", () => {
  const saved = fixture();
  const first = structuredClone(saved);
  first.layout.grid.root.size = 650;
  rememberLayoutResize(saved.id, saved, first);
  const revision = getLayoutResizeRevision(saved.id);
  const second = structuredClone(first);
  second.layout.grid.root.size = saved.layout.grid.root.size;
  rememberLayoutResize(saved.id, first, second);
  acknowledgeLayoutResize(saved.id, revision, first);
  assert.deepEqual(modifiedLayoutIds.get(), [saved.id]);
  acknowledgeLayoutResize(saved.id, getLayoutResizeRevision(saved.id), second);
  assert.deepEqual(modifiedLayoutIds.get(), []);
  rememberLayoutResize(saved.id, second, first);
  rememberLayoutSession(saved.id, saved, saved);
  assert.deepEqual(modifiedLayoutIds.get(), []);
});
