// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { activeLayoutKey } from "./dockview-active-layout";

/** Verifies semantically identical layouts compare equally across key order. */
test("activeLayoutKey ignores nested object insertion order", () => {
  const first = {
    version: 2,
    layout: {
      edgeGroups: {
        right: {
          id: "edge-Properties",
          activeView: "panel-PropertiesInspector",
        },
      },
    },
    panels: [{ id: "panel-PropertiesInspector", params: {} }],
  };
  const second = {
    version: 2,
    layout: {
      edgeGroups: {
        right: {
          activeView: "panel-PropertiesInspector",
          id: "edge-Properties",
        },
      },
    },
    panels: [{ params: {}, id: "panel-PropertiesInspector" }],
  };

  assert.equal(
    activeLayoutKey(first as never),
    activeLayoutKey(second as never),
  );
});
