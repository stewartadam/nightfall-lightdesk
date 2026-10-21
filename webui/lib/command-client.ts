// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { commandEnvelope } from "./command-envelope";

/** Transport behavior required by the generic command client. */
export interface CommandTransport {
  /** Sends one command envelope and returns its id, or null when it was not sent. */
  sendCommand(data: object, consoleCommandText?: string): string | null;
  /** Sends one command envelope and waits for its terminal result. */
  sendCommandAndAwait(
    data: object,
    consoleCommandText?: string,
  ): Promise<types.CommandResult>;
}

/** Per-command client behavior that is independent of the domain payload. */
export interface CommandOptions {
  /** Operator text associated with this command in console scrollback. */
  consoleCommandText?: string;
  /** Undo group shared with other commands; defaults to the command's own id. */
  undoId?: string;
}

/** Transport-independent entry point for typed domain commands. */
export class CommandClient {
  private readonly transport: CommandTransport;

  /** Creates a client over an application-supplied command transport. */
  constructor(transport: CommandTransport) {
    this.transport = transport;
  }

  /**
   * Sends one domain command without waiting for its result. Failures still surface through the
   * shared result handler as a toast or confirmation. Returns the command id, or null when the
   * command could not be sent.
   */
  emit<TCommand extends object>(
    module: string,
    command: TCommand,
    options: CommandOptions = {},
  ): string | null {
    return this.transport.sendCommand(
      commandEnvelope(module, command, options.undoId),
      options.consoleCommandText,
    );
  }

  /**
   * Sends one domain command and resolves with its terminal result. Rejects when the command
   * could not be sent or the runtime stopped before the result arrived.
   */
  invoke<TCommand extends object>(
    module: string,
    command: TCommand,
    options: CommandOptions = {},
  ): Promise<types.CommandResult> {
    return this.transport.sendCommandAndAwait(
      commandEnvelope(module, command, options.undoId),
      options.consoleCommandText,
    );
  }
}
