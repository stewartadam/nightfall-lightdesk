// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { TimelinePlacementPreference } from "../types";
import {
  timelinePlacementPosition,
  timelinePlacementPreference,
} from "./timeline-placement";

test("timelinePlacementPreference defaults to playhead", () => {
  assert.equal(
    timelinePlacementPreference(undefined),
    TimelinePlacementPreference.Playhead,
  );
});

test("timelinePlacementPosition uses cursor when configured and available", () => {
  assert.equal(
    timelinePlacementPosition({
      preference: TimelinePlacementPreference.Cursor,
      playheadMs: 1200,
      cursorMs: 3400,
    }),
    3400,
  );
});

test("timelinePlacementPosition falls back to playhead without cursor", () => {
  assert.equal(
    timelinePlacementPosition({
      preference: TimelinePlacementPreference.Cursor,
      playheadMs: 1200,
    }),
    1200,
  );
});
