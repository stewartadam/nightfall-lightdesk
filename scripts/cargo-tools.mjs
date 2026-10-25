// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The manifest that pins every Cargo-installed tool for local setup and CI. */
export const cargoToolsManifest = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "config/cargo-tools.json",
);

/**
 * Read the pinned Cargo tools as a map from crate name to exact version. Throws when the
 * manifest holds anything but string versions, so a typo fails setup and CI alike.
 */
export function readCargoTools(
  contents = readFileSync(cargoToolsManifest, "utf8"),
) {
  const tools = JSON.parse(contents);
  for (const [name, version] of Object.entries(tools)) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(
        `Pin ${name} to an exact version in ${cargoToolsManifest}`,
      );
    }
  }
  return tools;
}

/** Return the pinned version of one Cargo tool, failing when the manifest doesn't list it. */
export function cargoToolVersion(name, tools = readCargoTools()) {
  const version = tools[name];
  if (!version)
    throw new Error(`${name} is not pinned in ${cargoToolsManifest}`);
  return version;
}
