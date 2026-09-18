// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Discriminated websocket message shape accepted by the registry. */
export type TypedWsMessage = { type: string };

/** Extracts one message variant from a websocket message union. */
export type WsMessageOfType<
  Message extends TypedWsMessage,
  Type extends Message["type"],
> = Extract<Message, { type: Type }>;

/** Handles one websocket message variant after worker transport delivery. */
export type WsMessageHandler<
  Message extends TypedWsMessage,
  Type extends Message["type"],
> = (message: WsMessageOfType<Message, Type>) => void;

/** Dispatches websocket messages to explicitly registered typed handlers. */
export class WsMessageHandlerRegistry<Message extends TypedWsMessage> {
  private readonly handlers = new Map<string, (message: Message) => void>();

  /** Registers a handler for one websocket message type. */
  register<Type extends Message["type"]>(
    type: Type,
    handler: WsMessageHandler<Message, Type>,
  ): this {
    if (this.handlers.has(type)) {
      throw new Error(`WebSocket handler already registered for ${type}`);
    }
    this.handlers.set(type, (message) =>
      handler(message as WsMessageOfType<Message, Type>),
    );
    return this;
  }

  /** Dispatches a message and reports whether a handler consumed it. */
  dispatch(message: Message): boolean {
    const handler = this.handlers.get(message.type);
    if (!handler) return false;
    handler(message);
    return true;
  }

  /** Reports whether the registry has a handler for the message type. */
  has(type: Message["type"]): boolean {
    return this.handlers.has(type);
  }
}

/** Creates an empty typed websocket handler registry. */
export function createWsMessageHandlerRegistry<
  Message extends TypedWsMessage,
>(): WsMessageHandlerRegistry<Message> {
  return new WsMessageHandlerRegistry<Message>();
}
