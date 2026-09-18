// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

/** Transport behavior required by the generic command client. */
export interface CommandTransport {
  /** Sends one command envelope and waits for its terminal result. */
  sendCommandAndAwait(
    data: object,
    consoleCommandText?: string,
  ): Promise<types.CommandResult>;
}

/** Per-command client behavior that is independent of the domain payload. */
export interface SubmitCommandOptions {
  /** Operator text associated with this command in console scrollback. */
  consoleCommandText?: string;
}

/** Awaited transport-independent entry point for typed domain commands. */
export class CommandClient {
  private readonly transport: CommandTransport;

  /** Creates a client over an application-supplied command transport. */
  constructor(transport: CommandTransport) {
    this.transport = transport;
  }

  /** Submits one domain command and resolves only from its terminal result. */
  submitCommand<TCommand extends object>(
    module: string,
    command: TCommand,
    options: SubmitCommandOptions = {},
  ): Promise<types.CommandResult> {
    return this.transport.sendCommandAndAwait(
      { module, command },
      options.consoleCommandText,
    );
  }
}
