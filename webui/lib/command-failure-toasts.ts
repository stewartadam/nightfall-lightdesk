// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { decodeCorrelationId } from "./console-scrollback";

/** Upper bound on remembered command IDs, so unmatched entries cannot accumulate. */
const PRESENTED_LIMIT = 64;

/** Failed commands whose failure a richer, domain-specific toast already presented. */
const presentedFailures = new Set<string>();

/**
 * Records that a command's failure was already shown to the operator, so the generic
 * `CommandResult` failure toast for that command is skipped.
 */
export function markCommandFailurePresented(rawCommandId: unknown): void {
  const commandId = decodeCorrelationId(rawCommandId);
  if (!commandId) return;
  presentedFailures.add(commandId);
  while (presentedFailures.size > PRESENTED_LIMIT) {
    const oldest = presentedFailures.values().next().value;
    if (oldest === undefined) break;
    presentedFailures.delete(oldest);
  }
}

/**
 * Returns whether a command's failure was already presented, forgetting it afterwards
 * because each command reports exactly one terminal result.
 */
export function consumeCommandFailurePresented(rawCommandId: unknown): boolean {
  const commandId = decodeCorrelationId(rawCommandId);
  return commandId !== null && presentedFailures.delete(commandId);
}
