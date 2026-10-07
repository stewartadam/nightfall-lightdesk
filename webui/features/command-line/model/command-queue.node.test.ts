// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  commandQueueSummary,
  type PendingCommandSubmission,
  remainingStatementCount,
  unsentStatements,
} from "./command-queue";

const sequence: PendingCommandSubmission = {
  id: 1,
  command: "fix 311 red @ 100; fix 311 blue @ 100; sleep 4",
  statements: ["fix 311 red @ 100", "fix 311 blue @ 100", "sleep 4"],
  started: 1,
  settled: 0,
};

/** Counts each statement of a multi-statement submission until its result arrives. */
test("remainingStatementCount counts statements, not submissions", () => {
  assert.equal(remainingStatementCount([sequence]), 3);
  assert.equal(
    remainingStatementCount([{ ...sequence, started: 2, settled: 1 }]),
    2,
  );
  assert.equal(
    remainingStatementCount([{ ...sequence, started: 3, settled: 3 }]),
    0,
  );
});

/** Treats a submission that is still being split as a single statement. */
test("remainingStatementCount counts an unsplit submission once", () => {
  assert.equal(
    remainingStatementCount([
      { id: 2, command: "a; b", started: 0, settled: 0 },
    ]),
    1,
  );
});

/** Lists statements still waiting to be sent across every pending submission, in run order. */
test("unsentStatements lists statements behind the running one", () => {
  const save: PendingCommandSubmission = {
    id: 2,
    command: "save",
    statements: ["save"],
    started: 0,
    settled: 0,
  };
  assert.deepEqual(
    unsentStatements([sequence, save]).map((entry) => entry.statement),
    ["fix 311 blue @ 100", "sleep 4", "save"],
  );
});

/** Summarizes running and queued statements for the indicator's accessible name. */
test("commandQueueSummary separates running and queued statements", () => {
  assert.equal(commandQueueSummary([sequence]), "1 command running, 2 queued");
  assert.equal(
    commandQueueSummary([{ ...sequence, started: 3, settled: 2 }]),
    "1 command running",
  );
});
