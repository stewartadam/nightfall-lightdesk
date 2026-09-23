// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleGuideContent } from "./content";
import type { GuideContent } from "./lessons";

/** Sequential gates preserve author order, including text after actions and multiple prerequisites. */
test("content reveals through each prerequisite in order", () => {
  const content: GuideContent[] = [
    { type: "text", text: "Introduction" },
    { type: "prerequisite", panels: ["ProgrammerGrid"] },
    {
      type: "action",
      title: "Set intensity",
      body: "Enter this command",
      command: "@ 100",
    },
    { type: "text", text: "After the action" },
    { type: "prerequisite", panels: ["Visualizer"] },
    { type: "text", text: "Watch the lights" },
  ];
  assert.deepEqual(
    visibleGuideContent(content, () => false),
    content.slice(0, 2),
  );
  assert.deepEqual(
    visibleGuideContent(
      content,
      (item) => item.panels?.[0] === "ProgrammerGrid",
    ),
    content.slice(0, 5),
  );
  assert.deepEqual(
    visibleGuideContent(content, () => true),
    content,
  );
});
