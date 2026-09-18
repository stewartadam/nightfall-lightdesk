// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type ParsedShowfileSaveCommand = {
  name?: string;
};

const SIMPLE_SAVE_COMMAND_PATTERN = /^save(?:\s+([^;\s]+))?$/i;

/** Parses simple save command-line inputs that can safely bypass Eval. */
export function parseSimpleShowfileSaveCommand(
  commandInput: string,
): ParsedShowfileSaveCommand | null {
  const match = commandInput.trim().match(SIMPLE_SAVE_COMMAND_PATTERN);
  if (!match) {
    return null;
  }

  const [, name] = match;
  return name ? { name } : {};
}
