// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  restoreSerializedLayout,
  serializedLayoutGeometryKey,
  serializedLayoutKey,
} from "./dockview-layout";

/** Older active snapshots receive the same component and edge normalization as named layouts. */
test("restoring normalizes saved layouts without mutating their source", () => {
  const source = {
    version: 2,
    panels: [],
    layout: {
      grid: { root: { type: "branch", data: [] } },
      panels: { clips: { id: "clips", contentComponent: "ExecutorList" } },
    },
  };
  let restored: any;
  restoreSerializedLayout(
    {
      getEdgeGroup: () => undefined,
      fromJSON: (layout: unknown) => {
        restored = layout;
      },
    } as never,
    source,
  );
  assert.equal(restored.panels.clips.contentComponent, "ClipList");
  assert.equal(restored.edgeGroups.right.visible, false);
  assert.equal(source.layout.panels.clips.contentComponent, "ExecutorList");
  assert.equal("edgeGroups" in source.layout, false);
});

/** Focus is transient, but resizing, titles, and parameters are meaningful local edits. */
test("layout comparison ignores focus but preserves arrangement changes", () => {
  const source = {
    version: 2,
    panels: [{ id: "a", title: "A", params: { activeGroup: "parameter" } }],
    layout: {
      activeGroup: "one",
      grid: {
        root: {
          type: "leaf",
          size: 100,
          data: { id: "one", views: ["a", "b"], activeView: "a" },
        },
      },
    },
  };
  const focused = structuredClone(source);
  focused.layout.activeGroup = "two";
  focused.layout.grid.root.data.activeView = "b";
  assert.equal(serializedLayoutKey(source), serializedLayoutKey(focused));
  const resized = structuredClone(source);
  resized.layout.grid.root.size = 200;
  assert.notEqual(serializedLayoutKey(source), serializedLayoutKey(resized));
  assert.equal(
    serializedLayoutKey(source, false),
    serializedLayoutKey(resized, false),
  );
  assert.notEqual(
    serializedLayoutGeometryKey(source),
    serializedLayoutGeometryKey(resized),
  );
  const parameter = structuredClone(source);
  parameter.panels[0].params.activeGroup = "changed";
  assert.notEqual(serializedLayoutKey(source), serializedLayoutKey(parameter));
  assert.notEqual(
    serializedLayoutKey(source, false),
    serializedLayoutKey(parameter, false),
  );
  const renamed = structuredClone(source);
  renamed.panels[0].title = "Renamed";
  assert.notEqual(serializedLayoutKey(source), serializedLayoutKey(renamed));
});
