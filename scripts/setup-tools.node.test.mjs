// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readCargoTools } from "./cargo-tools.mjs";
import { installPlan, probeVersion } from "./setup-tools.mjs";

/** Checks that the checked-in manifest pins every tool CI and the docs refer to. */
test("the manifest pins every Cargo tool with an exact version", () => {
  assert.deepEqual(Object.keys(readCargoTools()).sort(), [
    "cargo-about",
    "cargo-hakari",
    "cargo-nextest",
    "mdbook",
    "typeshare-cli",
  ]);
  assert.throws(() => readCargoTools('{"mdbook": "0.5"}'), /exact version/);
});

/** Checks that versions come from the binary on PATH, and a missing tool reads as absent. */
test("installed versions come from the tool's own --version output", () => {
  /** Answer version probes as fixed command output. */
  const run = (command, args) =>
    ({
      "mdbook --version": { status: 0, stdout: "mdbook v0.5.4\n" },
      "cargo nextest --version": {
        status: 0,
        stdout: "cargo-nextest 0.9.146 (abc 2026-01-01)\nrelease: 0.9.146\n",
      },
    })[`${command} ${args.join(" ")}`] ?? { status: 1, stdout: "" };
  assert.equal(probeVersion("mdbook", run), "0.5.4");
  assert.equal(probeVersion("cargo-nextest", run), "0.9.146");
  assert.equal(probeVersion("typeshare-cli", run), undefined);
});

/**
 * Checks that only missing or mismatched tools are installed, with binstall when available, and
 * that naming an unpinned tool fails instead of installing nothing.
 */
test("the install plan covers only tools off their pin", () => {
  const tools = { mdbook: "0.5.4", "typeshare-cli": "1.13.3" };
  const installed = new Map([
    ["mdbook", "0.4.49"],
    ["typeshare-cli", "1.13.3"],
  ]);
  assert.deepEqual(installPlan(tools, installed), [
    {
      name: "mdbook",
      command: "cargo",
      args: ["install", "--force", "--locked", "mdbook", "--version", "0.5.4"],
    },
  ]);
  assert.deepEqual(
    installPlan(tools, new Map(), { binstall: true, only: ["typeshare-cli"] }),
    [
      {
        name: "typeshare-cli",
        command: "cargo",
        args: [
          "binstall",
          "--no-confirm",
          "--force",
          "--locked",
          "typeshare-cli@1.13.3",
        ],
      },
    ],
  );
  assert.throws(
    () => installPlan(tools, installed, { only: ["cargo-udeps"] }),
    /Not pinned/,
  );
});
