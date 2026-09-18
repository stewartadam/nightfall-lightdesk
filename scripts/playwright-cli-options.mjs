// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Extracts nightfall-specific options while preserving Playwright's argument order.
 */
export function extractPlaywrightCliOptions(args) {
  let browser;
  const playwrightArgs = [];
  let dataDir;
  let rustLog;
  let target;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--target") {
      if (target !== undefined) {
        throw new Error("--target may only be specified once");
      }

      const value = args[index + 1];
      if (value !== "native" && value !== "embedded-demo") {
        throw new Error("--target requires either native or embedded-demo");
      }

      target = value;
      index += 1;
      continue;
    }

    if (argument === "--browser") {
      if (browser !== undefined) {
        throw new Error("--browser may only be specified once");
      }

      const value = args[index + 1];
      if (value !== "chromium" && value !== "firefox") {
        throw new Error("--browser requires either chromium or firefox");
      }

      browser = value;
      index += 1;
      continue;
    }

    if (argument === "--data-dir") {
      if (dataDir !== undefined) {
        throw new Error("--data-dir may only be specified once");
      }

      const value = args[index + 1];
      if (
        value === undefined ||
        value.trim().length === 0 ||
        value.startsWith("--")
      ) {
        throw new Error("--data-dir requires a non-empty value");
      }

      dataDir = value;
      index += 1;
      continue;
    }

    if (argument !== "--rust-log") {
      playwrightArgs.push(argument);
      continue;
    }

    if (rustLog !== undefined) {
      throw new Error("--rust-log may only be specified once");
    }

    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error("--rust-log requires a non-empty value");
    }

    rustLog = value;
    index += 1;
  }

  return { browser, dataDir, playwrightArgs, rustLog, target };
}
