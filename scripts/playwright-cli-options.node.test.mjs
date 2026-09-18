// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractPlaywrightCliOptions } from "./playwright-cli-options.mjs";

/** Verifies the wrapper consumes the backend log filter without reordering Playwright arguments. */
test("extracts the rust log filter from Playwright arguments", () => {
  const options = extractPlaywrightCliOptions([
    "test",
    "--rust-log",
    "nightfall_websocket=trace,nightfall_fx::events=trace,warn",
    "webui/e2e/step-fx-editor.spec.ts",
    "--grep",
    "first-release authoring workflow",
  ]);

  assert.deepEqual(options, {
    target: undefined,
    browser: undefined,
    dataDir: undefined,
    playwrightArgs: [
      "test",
      "webui/e2e/step-fx-editor.spec.ts",
      "--grep",
      "first-release authoring workflow",
    ],
    rustLog: "nightfall_websocket=trace,nightfall_fx::events=trace,warn",
  });
});

/** Verifies ordinary Playwright commands remain unchanged when no wrapper option is present. */
test("preserves Playwright arguments without a rust log filter", () => {
  const options = extractPlaywrightCliOptions(["test", "--headed"]);

  assert.deepEqual(options, {
    target: undefined,
    browser: undefined,
    dataDir: undefined,
    playwrightArgs: ["test", "--headed"],
    rustLog: undefined,
  });
});

/** Verifies the wrapper consumes a source data directory without reordering Playwright arguments. */
test("extracts the data directory from Playwright arguments", () => {
  const options = extractPlaywrightCliOptions([
    "test",
    "webui/e2e/sample-blueprints-visual.spec.ts",
    "--data-dir",
    "/tmp/nightfall-sample-blueprints",
  ]);

  assert.deepEqual(options, {
    target: undefined,
    browser: undefined,
    dataDir: "/tmp/nightfall-sample-blueprints",
    playwrightArgs: ["test", "webui/e2e/sample-blueprints-visual.spec.ts"],
    rustLog: undefined,
  });
});

/** Verifies the wrapper selects Firefox without forwarding its private browser option to Playwright. */
test("extracts a browser selection from Playwright arguments", () => {
  const options = extractPlaywrightCliOptions([
    "test",
    "--browser",
    "firefox",
    "webui/e2e/browser-demo.spec.ts",
  ]);

  assert.deepEqual(options, {
    target: undefined,
    browser: "firefox",
    dataDir: undefined,
    playwrightArgs: ["test", "webui/e2e/browser-demo.spec.ts"],
    rustLog: undefined,
  });
});

/** Verifies invalid or ambiguous browser selections fail before invoking Playwright. */
test("rejects invalid browser selections", () => {
  assert.throws(
    () => extractPlaywrightCliOptions(["test", "--browser"]),
    /--browser requires either chromium or firefox/,
  );
  assert.throws(
    () => extractPlaywrightCliOptions(["test", "--browser", "webkit"]),
    /--browser requires either chromium or firefox/,
  );
  assert.throws(
    () =>
      extractPlaywrightCliOptions([
        "test",
        "--browser",
        "chromium",
        "--browser",
        "firefox",
      ]),
    /--browser may only be specified once/,
  );
});

/** Verifies missing data-directory directives fail before invoking Playwright. */
test("rejects a data directory flag without a value", () => {
  assert.throws(
    () => extractPlaywrightCliOptions(["test", "--data-dir"]),
    /--data-dir requires a non-empty value/,
  );
  assert.throws(
    () => extractPlaywrightCliOptions(["test", "--data-dir", "--headed"]),
    /--data-dir requires a non-empty value/,
  );
  assert.throws(
    () => extractPlaywrightCliOptions(["test", "--data-dir", "   "]),
    /--data-dir requires a non-empty value/,
  );
});

/** Verifies ambiguous repeated data-directory overrides fail before invoking Playwright. */
test("rejects repeated data directory flags", () => {
  assert.throws(
    () =>
      extractPlaywrightCliOptions([
        "test",
        "--data-dir",
        "/tmp/one",
        "--data-dir",
        "/tmp/two",
      ]),
    /--data-dir may only be specified once/,
  );
});

/** Verifies missing rust log directives fail before invoking Playwright. */
test("rejects a rust log flag without a value", () => {
  assert.throws(
    () => extractPlaywrightCliOptions(["test", "--rust-log"]),
    /--rust-log requires a non-empty value/,
  );
  assert.throws(
    () => extractPlaywrightCliOptions(["test", "--rust-log", "--headed"]),
    /--rust-log requires a non-empty value/,
  );
});

/** Verifies ambiguous repeated rust log filters fail before invoking Playwright. */
test("rejects repeated rust log flags", () => {
  assert.throws(
    () =>
      extractPlaywrightCliOptions([
        "test",
        "--rust-log",
        "warn",
        "--rust-log",
        "trace",
      ]),
    /--rust-log may only be specified once/,
  );
});

/** Verifies target selection is consumed while test filters retain their order. */
test("extracts native and embedded-demo targets", () => {
  for (const target of ["native", "embedded-demo"]) {
    const options = extractPlaywrightCliOptions([
      "test",
      "webui/e2e/browser-demo.spec.ts",
      "--target",
      target,
      "--grep",
      "browser demo",
    ]);
    assert.equal(options.target, target);
    assert.deepEqual(options.playwrightArgs, [
      "test",
      "webui/e2e/browser-demo.spec.ts",
      "--grep",
      "browser demo",
    ]);
  }
});

/** Verifies missing, unsupported, and repeated targets fail before setup. */
test("rejects invalid or ambiguous targets", () => {
  for (const value of [undefined, "", "   ", "--headed", "typo"]) {
    const args = ["test", "--target"];
    if (value !== undefined) args.push(value);
    assert.throws(
      () => extractPlaywrightCliOptions(args),
      /--target requires either native or embedded-demo/,
    );
  }
  assert.throws(
    () =>
      extractPlaywrightCliOptions([
        "test",
        "--target",
        "native",
        "--target",
        "embedded-demo",
      ]),
    /--target may only be specified once/,
  );
});
