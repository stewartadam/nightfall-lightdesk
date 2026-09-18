// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatMoveTranslateOverlayLabel } from "../interactions/use-move-tool-interaction";
import {
  formatRotateAngleOverlayLabel,
  formatSignedDegrees,
  wrapSignedDegrees,
} from "../interactions/use-rotate-tool-interaction";

test("move overlay label includes delta and resulting absolute position", () => {
  assert.equal(
    formatMoveTranslateOverlayLabel("y", 1.234, 5.678),
    "Y: 1.23m -> 5.68m",
  );
});

test("rotate overlay label includes signed delta and absolute angle", () => {
  assert.equal(formatSignedDegrees(12.345), "+12.3°");
  assert.equal(formatSignedDegrees(-3.21), "-3.2°");
  assert.equal(wrapSignedDegrees(350), -10);
  assert.equal(
    formatRotateAngleOverlayLabel("z", wrapSignedDegrees(350), 350),
    "Z: -10.0° -> 350.0°",
  );
});
