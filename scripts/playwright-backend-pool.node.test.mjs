// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sampleDataBootstrapEnvironment } from "./playwright-backend-pool.mjs";

/** Verify an incomplete seed falls back to bootstrapping and saving the sample show. */
test("incomplete seeds bootstrap the sample show", () => {
  assert.deepEqual(
    sampleDataBootstrapEnvironment({
      seedDataAvailable: false,
      emptyStartupWorld: false,
    }),
    {
      NIGHTFALL_SAMPLE_DATA: "1",
      NIGHTFALL_STARTUP_CMDS: "save sample; save default",
    },
  );
});

/** Verify a complete seed starts the backend without loading a world. */
test("complete seeds leave the backend unbootstrapped", () => {
  assert.deepEqual(
    sampleDataBootstrapEnvironment({
      seedDataAvailable: true,
      emptyStartupWorld: false,
    }),
    {},
  );
});

/** Verify startup-flow tests keep the backend Initialized even without seed showfiles. */
test("empty startup worlds skip the sample fallback", () => {
  assert.deepEqual(
    sampleDataBootstrapEnvironment({
      seedDataAvailable: false,
      emptyStartupWorld: true,
    }),
    {},
  );
});
