// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Websocket command payload with optional undo grouping supplied by the caller.
 */
export type CommandEnvelope<Command> = {
  undo_id?: string;
  module: string;
  command: Command;
};

/**
 * Builds a websocket command payload, adding undo metadata when supplied.
 */
export function commandEnvelope<Command>(
  module: string,
  command: Command,
  undoId?: string,
): CommandEnvelope<Command> {
  return undoId ? { undo_id: undoId, module, command } : { module, command };
}
