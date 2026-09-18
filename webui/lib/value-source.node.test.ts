// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import {
  assertionStyleForMarkerEdit,
  convertValueSourceAssertionStyle,
  parameterValueForValueSource,
  parseValueSourceEdit,
  parseValueSourceEditResult,
  valueSourceToProcessedParameterValue,
} from "./value-source";

/** Builds an absolute parameter value for value-source helper tests. */
function absolute(value: number): types.ParameterValue {
  return { type: "Absolute", data: { value } };
}

/** Verifies marker-only edits map to assertion style conversion requests. */
test("assertionStyleForMarkerEdit recognizes bare assertion markers", () => {
  assert.equal(assertionStyleForMarkerEdit(" @ "), "absolute");
  assert.equal(assertionStyleForMarkerEdit(" ~ "), "relative");
  assert.equal(assertionStyleForMarkerEdit("@75%"), undefined);
});

/** Verifies value source assertion style conversion preserves numeric values. */
test("convertValueSourceAssertionStyle preserves inline and fanned values", () => {
  assert.deepEqual(
    convertValueSourceAssertionStyle(
      {
        type: "Inline",
        data: { type: "RelativePercent", data: { offset: 0.75 } },
      },
      "absolute",
    ),
    {
      type: "Inline",
      data: { type: "AbsolutePercent", data: { value: 0.75 } },
    },
  );
  assert.deepEqual(
    convertValueSourceAssertionStyle(
      {
        type: "Fanned",
        data: {
          values: [
            { type: "Absolute", data: { value: 10 } },
            { type: "AbsolutePercent", data: { value: 0.5 } },
          ],
        },
      },
      "relative",
    ),
    {
      type: "Fanned",
      data: {
        values: [
          { type: "Relative", data: { offset: 10 } },
          { type: "RelativePercent", data: { offset: 0.5 } },
        ],
      },
    },
  );
  assert.equal(
    convertValueSourceAssertionStyle({ type: "Release" }, "absolute"),
    undefined,
  );
});

/** Verifies marker value sources convert into grid-ready marker values. */
test("valueSourceToProcessedParameterValue converts cue markers", () => {
  assert.deepEqual(valueSourceToProcessedParameterValue({ type: "Release" }), {
    marker: "release",
    isPercentage: false,
    isRelative: false,
  });
  assert.deepEqual(
    valueSourceToProcessedParameterValue({ type: "HoldPosition" }),
    {
      marker: "hold",
      isPercentage: false,
      isRelative: false,
    },
  );
});

/** Verifies block-prefixed edits parse as ordinary asserted values. */
test("parseValueSourceEdit parses block display text as inline value", () => {
  assert.deepEqual(parseValueSourceEdit("B 42"), {
    type: "Inline",
    data: absolute(42),
  });
  assert.deepEqual(parseValueSourceEdit("release"), { type: "Release" });
  assert.deepEqual(parseValueSourceEdit("hold"), { type: "HoldPosition" });
});

/** Verifies value source edit parsing separates blank clears from invalid input. */
test("parseValueSourceEditResult distinguishes empty and invalid edits", () => {
  assert.deepEqual(parseValueSourceEditResult("   "), { type: "Empty" });
  assert.deepEqual(parseValueSourceEditResult("not-a-value"), {
    type: "Invalid",
  });
  assert.deepEqual(parseValueSourceEditResult("B nope"), { type: "Invalid" });
  assert.deepEqual(parseValueSourceEditResult("75%"), {
    type: "Valid",
    source: {
      type: "Inline",
      data: { type: "AbsolutePercent", data: { value: 0.75 } },
    },
  });
});

/** Verifies fanned value sources resolve to the value at a selection position. */
test("parameterValueForValueSource interpolates fanned values", () => {
  assert.deepEqual(
    parameterValueForValueSource(
      {
        type: "Fanned",
        data: {
          values: [absolute(0), absolute(100)],
        },
      },
      1,
      3,
    ),
    absolute(50),
  );
});
