// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Identifies CLI operations that can start a native browser, including UI mode. */
export function mayLaunchPlaywrightBrowser(args) {
  const options = args.slice(
    0,
    args.indexOf("--") < 0 ? args.length : args.indexOf("--"),
  );
  // Only recognize leading flags so values such as `--grep --help` cannot
  // masquerade as informational commands without parsing Playwright's CLI.
  if ([args[0], args[1]].some((arg) => arg === "--help" || arg === "-h")) {
    return false;
  }
  const command = args[0];
  if (
    command === undefined ||
    [
      "help",
      "--version",
      "-V",
      "install",
      "install-deps",
      "uninstall",
      "clear-cache",
    ].includes(command)
  ) {
    return false;
  }
  if (command === "test" && args[1] === "--list") {
    return options.some((option) => /^--ui(?:$|[=-])/.test(option));
  }
  return true;
}

/** Rejects known macOS agent sandbox launches before native application setup. */
export function playwrightSandboxError(
  args,
  environment = process.env,
  platform = process.platform,
) {
  if (
    platform !== "darwin" ||
    environment.CODEX_SANDBOX !== "seatbelt" ||
    !mayLaunchPlaywrightBrowser(args)
  ) {
    return undefined;
  }
  return (
    "Playwright browser launch blocked: CODEX_SANDBOX=seatbelt on macOS. " +
    "The sandbox denies macOS application registration and can crash headed or headless browsers with SIGABRT. " +
    "Run this repository wrapper with approved escalated execution outside the agent sandbox, " +
    "or run the same command directly in Terminal. Do not retry inside the sandbox or unset CODEX_SANDBOX."
  );
}
