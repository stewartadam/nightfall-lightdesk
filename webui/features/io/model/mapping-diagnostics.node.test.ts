// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GridCellKind } from "../../../lib/data-grid-types";
import type { InvocationError } from "../../../types";
import {
  diagnosticsByMapping,
  mappingStatusCell,
  mappingStatusText,
} from "./mapping-diagnostics";

const MISSING_CLIP: InvocationError = {
  code: "clip.not_found",
  message: "Clip with UID 42 does not exist",
};

/** Verifies diagnostics match mapping IDs whether they arrive as UUID strings or bytes. */
test("diagnosticsByMapping matches string and byte mapping IDs", () => {
  const bytes = Array.from({ length: 16 }, (_, index) => index);
  const hex = bytes.map((value) => value.toString(16).padStart(2, "0"));
  const hyphenated = [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10),
  ]
    .map((part) => part.join(""))
    .join("-");
  const errorFor = diagnosticsByMapping([
    { binding_id: hyphenated, error: MISSING_CLIP },
  ]);

  assert.equal(errorFor(hyphenated), MISSING_CLIP);
  assert.equal(errorFor(bytes), MISSING_CLIP);
  assert.equal(errorFor(Uint8Array.from(bytes)), MISSING_CLIP);
  assert.equal(errorFor("ffffffff-ffff-ffff-ffff-ffffffffffff"), undefined);
});

/** Verifies a diagnosed row shows the failure behind an error tag and a healthy row shows OK. */
test("mappingStatusCell flags diagnosed mappings", () => {
  const failed = mappingStatusCell(MISSING_CLIP);
  assert.equal(failed.kind, GridCellKind.Text);
  assert.equal(
    failed.kind === GridCellKind.Text && failed.displayData,
    MISSING_CLIP.message,
  );
  assert.deepEqual(failed.stateIndicators, [
    {
      label: `Mapping problem: ${MISSING_CLIP.message}`,
      tone: "error",
      variant: "tag",
      text: "!",
    },
  ]);

  const healthy = mappingStatusCell(undefined);
  assert.equal(healthy.stateIndicators, undefined);
  assert.equal(healthy.kind === GridCellKind.Text && healthy.displayData, "OK");
});

/** Verifies the filterable status text matches what the cell displays. */
test("mappingStatusText mirrors the displayed status", () => {
  assert.equal(mappingStatusText(MISSING_CLIP), MISSING_CLIP.message);
  assert.equal(mappingStatusText(undefined), "OK");
});
