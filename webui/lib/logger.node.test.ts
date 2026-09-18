// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LogLevel } from "loglayer";
import {
  configure,
  createLogger,
  moduleNameFromPath,
  setModuleLogLevel,
} from "./logger";

test("configure reset removes shorthand module trace override", () => {
  const logger = createLogger("components:visualizer2:geometry-builder");

  configure("info,geometry-builder=trace", false);
  assert.equal(logger.getEffectiveLevel(), LogLevel.trace);

  configure("info", false);
  assert.equal(logger.getEffectiveLevel(), LogLevel.info);
});

test("most specific shorthand suffix override wins", () => {
  const logger = createLogger("components:visualizer2:geometry-builder");

  configure("info,visualizer2=warn,geometry-builder=trace", false);
  assert.equal(logger.getEffectiveLevel(), LogLevel.trace);
});

test("setModuleLogLevel accepts shorthand module suffixes", () => {
  const logger = createLogger("components:visualizer2:geometry-builder");

  configure("info", false);
  setModuleLogLevel("geometry-builder", LogLevel.debug, false);
  assert.equal(logger.getEffectiveLevel(), LogLevel.debug);

  setModuleLogLevel("geometry-builder", null, false);
  assert.equal(logger.getEffectiveLevel(), LogLevel.info);
});

test("moduleNameFromPath normalizes visualizer module name", () => {
  assert.equal(
    moduleNameFromPath(
      "file:///workspace/nightfall/webui/components/visualizer2/geometry-builder.ts",
    ),
    "components:visualizer2:geometry-builder",
  );
});

test("isEnabled respects exact and suffix module overrides", () => {
  const rootLogger = createLogger("nanostores");
  const storeLogger = createLogger("nanostores:fixtures");
  const nestedLogger = createLogger("components:visualizer2:geometry-builder");

  configure("info,nanostores:fixtures=trace,geometry-builder=debug", false);

  assert.equal(rootLogger.isEnabled(LogLevel.trace), false);
  assert.equal(storeLogger.isEnabled(LogLevel.trace), true);
  assert.equal(nestedLogger.isEnabled(LogLevel.debug), true);
  assert.equal(nestedLogger.isEnabled(LogLevel.trace), false);

  configure("info", false);
});
