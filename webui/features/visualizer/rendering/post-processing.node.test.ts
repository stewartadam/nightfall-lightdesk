// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SRGBColorSpace } from "three/webgpu";
import {
  defaultPostProcessingConfig,
  displayColorComponents,
} from "./effects/post-processing";

/** Verifies visualizer outline classes use distinct colors. */
test("selection outlines use separate programmer, edit, and value colors", () => {
  assert.equal(defaultPostProcessingConfig.outlineVisibleColor, "#ffffff");
  assert.equal(defaultPostProcessingConfig.outlineHiddenColor, "#9ca3af");
  assert.equal(
    defaultPostProcessingConfig.editSelectionOutlineVisibleColor,
    "#facc15",
  );
  assert.equal(
    defaultPostProcessingConfig.editSelectionOutlineHiddenColor,
    "#ca8a04",
  );
  assert.equal(
    defaultPostProcessingConfig.programmerValueOutlineVisibleColor,
    "#ef4444",
  );
  assert.equal(
    defaultPostProcessingConfig.programmerValueOutlineHiddenColor,
    "#991b1b",
  );
});

/**
 * Outlines are composited after tone mapping and sRGB encoding, so their colors must be the
 * configured sRGB components rather than linear working-space values.
 */
test("outline colors resolve to their exact display-space components", () => {
  const { r, g, b } = displayColorComponents(
    defaultPostProcessingConfig.editSelectionOutlineVisibleColor,
    SRGBColorSpace,
  );
  assert.ok(Math.abs(r - 0xfa / 255) < 1e-4, `red ${r}`);
  assert.ok(Math.abs(g - 0xcc / 255) < 1e-4, `green ${g}`);
  assert.ok(Math.abs(b - 0x15 / 255) < 1e-4, `blue ${b}`);
});
