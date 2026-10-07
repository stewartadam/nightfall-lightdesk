// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** One accepted command-line submission that has not settled yet. */
export interface PendingCommandSubmission {
  id: number;
  /** The input exactly as the operator submitted it. */
  command: string;
  /** The submission's statements, once split; undefined while splitting. */
  statements?: readonly string[];
  /** Number of statements already sent to the backend. */
  started: number;
  /** Number of statements whose terminal result has arrived. */
  settled: number;
}

/** One statement accepted by the command line that has not been sent yet. */
export interface QueuedCommandStatement {
  key: string;
  statement: string;
}

/** Returns a submission's statements, treating an unsplit input as one statement. */
function submissionStatements(
  submission: PendingCommandSubmission,
): readonly string[] {
  return submission.statements ?? [submission.command];
}

/** Counts statements across pending submissions that are still running or waiting to run. */
export function remainingStatementCount(
  pending: readonly PendingCommandSubmission[],
): number {
  return pending.reduce(
    (total, submission) =>
      total +
      Math.max(0, submissionStatements(submission).length - submission.settled),
    0,
  );
}

/** Lists statements that have not been sent yet, in the order they will run. */
export function unsentStatements(
  pending: readonly PendingCommandSubmission[],
): QueuedCommandStatement[] {
  return pending.flatMap((submission) =>
    submissionStatements(submission)
      .slice(submission.started)
      .map((statement, offset) => ({
        key: `${submission.id}:${submission.started + offset}`,
        statement,
      })),
  );
}

/** Describes running and queued statements for the queue indicator's accessible name. */
export function commandQueueSummary(
  pending: readonly PendingCommandSubmission[],
): string {
  const remaining = remainingStatementCount(pending);
  const queued = unsentStatements(pending).length;
  const running = remaining - queued;
  const parts = [];
  if (running > 0)
    parts.push(`${running} command${running === 1 ? "" : "s"} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.join(", ");
}
