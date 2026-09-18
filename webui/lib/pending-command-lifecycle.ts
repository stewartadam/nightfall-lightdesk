// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Maps transport waiters and result metadata by normalized command identity. */
export interface PendingCommandLifecycleState<Waiter, Metadata> {
  waiters: Map<string, Waiter>;
  resultMetadata: Map<string, Metadata>;
}

/** Values consumed when a semantic command result arrives. */
export interface SettledPendingCommand<Waiter, Metadata> {
  waiter?: Waiter;
  resultMetadata?: Metadata;
}

/** Consumes both the waiter and metadata when the backend result eventually arrives. */
export function settlePendingCommand<Waiter, Metadata>(
  state: PendingCommandLifecycleState<Waiter, Metadata>,
  commandId: string,
): SettledPendingCommand<Waiter, Metadata> {
  const waiter = state.waiters.get(commandId);
  const resultMetadata = state.resultMetadata.get(commandId);
  state.waiters.delete(commandId);
  state.resultMetadata.delete(commandId);
  return { waiter, resultMetadata };
}

/** Discards all state when a command could not be submitted to the backend. */
export function abandonPendingCommand<Waiter, Metadata>(
  state: PendingCommandLifecycleState<Waiter, Metadata>,
  commandId: string,
): void {
  state.waiters.delete(commandId);
  state.resultMetadata.delete(commandId);
}
