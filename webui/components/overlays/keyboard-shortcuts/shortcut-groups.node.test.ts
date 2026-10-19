// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  GLOBAL_GROUP,
  type GroupableShortcut,
  groupShortcuts,
} from "./shortcut-groups";

/** Panel type of each test panel instance, standing in for the panel definitions. */
const PANEL_TYPES: Record<string, string> = {
  "timeline-list": "Timelines",
  "timeline-list:second": "Timelines",
  clips: "Clips",
  visualizer: "3D Visualizer",
};

/** Labels a test shortcut by its panel's type, or Global without a panel. */
function labelFor(shortcut: GroupableShortcut): string {
  return shortcut.componentId
    ? PANEL_TYPES[shortcut.componentId]
    : GLOBAL_GROUP;
}

const shortcuts: GroupableShortcut[] = [
  { description: "Create clip", key: "n", componentId: "clips" },
  { description: "Undo", key: "$mod+z" },
  { description: "Create timeline", key: "n", componentId: "timeline-list" },
  {
    description: "Create timeline",
    key: "n",
    componentId: "timeline-list:second",
  },
  {
    description: "Toggle beams",
    key: "b",
    componentId: "visualizer",
  },
];

/** Verifies two open panels of one type share a heading and list each binding once. */
test("groups open panels by type without repeating their shortcuts", () => {
  const groups = groupShortcuts(shortcuts, labelFor, null);
  const timelines = groups.find((group) => group.label === "Timelines");
  assert.deepEqual(timelines?.rows, [
    { description: "Create timeline", keys: ["n"] },
  ]);
  assert.equal(groups.filter((group) => group.label === "Timelines").length, 1);
});

/** Verifies Global leads and the remaining panel types follow alphabetically. */
test("orders Global first and panel types alphabetically", () => {
  assert.deepEqual(
    groupShortcuts(shortcuts, labelFor, null).map((group) => group.label),
    [GLOBAL_GROUP, "3D Visualizer", "Clips", "Timelines"],
  );
});

/** Verifies the active panel's type moves right after Global and is flagged, whichever instance is active. */
test("lists the active panel type right after Global", () => {
  const groups = groupShortcuts(shortcuts, labelFor, "timeline-list:second");
  assert.deepEqual(
    groups.map((group) => [group.label, group.active]),
    [
      [GLOBAL_GROUP, false],
      ["Timelines", true],
      ["3D Visualizer", false],
      ["Clips", false],
    ],
  );
});
