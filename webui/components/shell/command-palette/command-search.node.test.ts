// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CommandAction } from "../../providers/command-registry";
import {
  groupCommandPaletteCommands,
  rankCommandPaletteCommands,
} from "./command-search";

/** Builds a command action with inert execution for search ranking tests. */
function command(
  id: string,
  name: string,
  description?: string,
  category = "Panels",
): CommandAction {
  return {
    id,
    name,
    description,
    category,
    execute: () => {},
  };
}

/** Returns command ids after ranking the supplied commands by query. */
function rankedIds(
  commands: readonly CommandAction[],
  query: string,
): string[] {
  return rankCommandPaletteCommands(commands, query).map(({ id }) => id);
}

/** Verifies concise panel titles outrank longer panel titles for direct word matches. */
test("command palette search ranks shorter direct panel title matches first", () => {
  assert.deepEqual(
    rankedIds(
      [
        command(
          "fixture-library",
          "Open Fixture Library",
          "Open a new Fixture Library panel",
        ),
        command("fixtures", "Open Fixtures", "Open a new Fixtures panel"),
      ],
      "fixture",
    ),
    ["fixtures", "fixture-library"],
  );

  assert.deepEqual(
    rankedIds(
      [
        command(
          "console-dmx",
          "Open Console DMX",
          "Open a new Console DMX panel",
        ),
        command("console", "Open Console", "Open a new Console panel"),
      ],
      "console",
    ),
    ["console", "console-dmx"],
  );
});

/** Verifies a more specific typed phrase still selects the matching longer title. */
test("command palette search ranks exact phrase matches before shorter partials", () => {
  assert.deepEqual(
    rankedIds(
      [
        command("fixtures", "Open Fixtures", "Open a new Fixtures panel"),
        command(
          "fixture-library",
          "Open Fixture Library",
          "Open a new Fixture Library panel",
        ),
      ],
      "fixture library",
    ),
    ["fixture-library"],
  );
});

/** Verifies name matches remain more important than category or description matches. */
test("command palette search ranks command names before metadata matches", () => {
  assert.deepEqual(
    rankedIds(
      [
        command("metadata-match", "Open Patch", "Open fixture tools"),
        command("name-match", "Fixture Tools", "Open patch helpers"),
      ],
      "fixture",
    ),
    ["name-match", "metadata-match"],
  );
});

/** Verifies equal-quality matches keep the source registration order. */
test("command palette search preserves source order for equal matches", () => {
  assert.deepEqual(
    rankedIds(
      [
        command("one", "Open A Fixture", "Open fixture one"),
        command("two", "Open B Fixture", "Open fixture two"),
      ],
      "fixture",
    ),
    ["one", "two"],
  );
});

/** Verifies search result grouping does not reorder ranked cross-category matches. */
test("command palette search groups preserve ranked command order", () => {
  const commands = [
    command("panel", "Open Fixture Library", "Open fixture tools", "Panels"),
    command(
      "timeline",
      "Fixture Tools",
      "Open timeline fixture tools",
      "Timeline",
    ),
    command("layout", "Open Fixture Layout", "Open fixture layout", "Layout"),
  ];
  const rankedCommands = rankCommandPaletteCommands(commands, "fixture");
  const groupedCommands = groupCommandPaletteCommands(rankedCommands, true);

  assert.deepEqual(
    groupedCommands.flatMap((group) => group.commands.map(({ id }) => id)),
    rankedCommands.map(({ id }) => id),
  );
  assert.deepEqual(
    groupedCommands.map(({ category }) => category),
    rankedCommands.map(({ category }) => category),
  );
});
