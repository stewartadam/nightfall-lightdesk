// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types/index";
import {
  appendConsoleScrollbackEntry,
  createImmediateErrorConsoleScrollbackEntry,
  createPendingConsoleScrollbackEntry,
  decodeCorrelationId,
  markPendingConsoleScrollbackEntriesUnknown,
  normalizeCorrelationId,
  resolveConsoleScrollbackEntryByCorrelation,
  upsertPendingConsoleScrollbackEntry,
} from "./console-scrollback";

test("normalizeCorrelationId strips hyphens and lowercases", () => {
  assert.equal(
    normalizeCorrelationId("A0B1C2D3-E4F5-6789-ABCD-EF0123456789"),
    "a0b1c2d3e4f56789abcdef0123456789",
  );
});

test("decodeCorrelationId supports string and Uint8Array UUID forms", () => {
  assert.equal(
    decodeCorrelationId("a0b1c2d3-e4f5-6789-abcd-ef0123456789"),
    "a0b1c2d3e4f56789abcdef0123456789",
  );

  const bytes = new Uint8Array([
    0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01,
    0x23, 0x45, 0x67, 0x89,
  ]);
  assert.equal(decodeCorrelationId(bytes), "a0b1c2d3e4f56789abcdef0123456789");
});

test("appendConsoleScrollbackEntry enforces retention limit", () => {
  const first = createPendingConsoleScrollbackEntry("cmd 1", "1111", 1);
  const second = createPendingConsoleScrollbackEntry("cmd 2", "2222", 2);
  const third = createPendingConsoleScrollbackEntry("cmd 3", "3333", 3);

  const entries = appendConsoleScrollbackEntry(
    appendConsoleScrollbackEntry(
      appendConsoleScrollbackEntry([], first, 2),
      second,
      2,
    ),
    third,
    2,
  );

  assert.equal(entries.length, 2);
  assert.equal(entries[0].command, "cmd 2");
  assert.equal(entries[1].command, "cmd 3");
  assert.equal(entries[1].source, "UI");
});

test("resolveConsoleScrollbackEntryByCorrelation updates status and inline error", () => {
  const correlationId = "a0b1c2d3e4f56789abcdef0123456789";
  const pending = createPendingConsoleScrollbackEntry(
    "fixture 1 at 100",
    correlationId,
    100,
  );
  const seed = [
    pending,
    createImmediateErrorConsoleScrollbackEntry("noop", "x", 50),
  ];

  const errorResult: types.CommandOutcome = {
    type: "Failed",
    data: {
      code: "command.parse_failed",
      message: "parse error near 'fixture'",
      details: null,
    },
  };
  const failed = resolveConsoleScrollbackEntryByCorrelation(
    seed,
    correlationId,
    errorResult,
    120,
  );

  assert.equal(failed[0].status, "error");
  assert.equal(failed[0].completedAt, 120);
  assert.equal(failed[0].errorMessage, "parse error near 'fixture'");

  const successResult: types.CommandOutcome = {
    type: "Succeeded",
    data: {},
  };
  const succeeded = resolveConsoleScrollbackEntryByCorrelation(
    failed,
    correlationId,
    successResult,
    130,
  );

  assert.equal(succeeded[0].status, "success");
  assert.equal(succeeded[0].completedAt, 130);
  assert.equal(succeeded[0].errorMessage, undefined);

  const messageResult: types.CommandOutcome = {
    type: "Succeeded",
    data: { output: { value: "Color Paths:\n1 RGB" } },
  };
  const messaged = resolveConsoleScrollbackEntryByCorrelation(
    succeeded,
    correlationId,
    messageResult,
    140,
  );

  assert.equal(messaged[0].status, "success");
  assert.equal(messaged[0].completedAt, 140);
  assert.equal(messaged[0].errorMessage, undefined);
  assert.equal(messaged[0].resultMessage, "Color Paths:\n1 RGB");
});

test("upsertPendingConsoleScrollbackEntry updates existing entries by correlation", () => {
  const correlationId = "a0b1c2d3e4f56789abcdef0123456789";
  const seed = [
    createPendingConsoleScrollbackEntry("clip 1 go", correlationId, 100, "UI"),
  ];

  const next = upsertPendingConsoleScrollbackEntry(
    seed,
    "clip 1 stop",
    correlationId,
    "OSC 127.0.0.1:9000",
  );
  assert.equal(next.length, 1);
  assert.equal(next[0].command, "clip 1 stop");
  assert.equal(next[0].source, "OSC 127.0.0.1:9000");
});

/**
 * A resync flags only rows still waiting on a result, leaves settled rows untouched, and a result
 * that arrives afterwards still settles the flagged row.
 */
test("markPendingConsoleScrollbackEntriesUnknown flags only pending rows", () => {
  const pendingId = "a0b1c2d3e4f56789abcdef0123456789";
  const pending = createPendingConsoleScrollbackEntry("go 1", pendingId, 10);
  const settled = createImmediateErrorConsoleScrollbackEntry("noop", "x", 5);

  const marked = markPendingConsoleScrollbackEntriesUnknown(
    [settled, pending],
    "Result lost",
    undefined,
    20,
  );

  assert.equal(marked[0], settled);
  assert.equal(marked[1].status, "unknown");
  assert.equal(marked[1].completedAt, 20);
  assert.equal(marked[1].warningMessage, "Result lost");

  const late = resolveConsoleScrollbackEntryByCorrelation(
    marked,
    pendingId,
    { type: "Succeeded", data: {} },
    30,
  );
  assert.equal(late[1].status, "success");
  assert.equal(late[1].warningMessage, undefined);
});

/**
 * The row parked behind the selection-flatten dialog already has its result, so it stays pending
 * while other pending rows are flagged; the kept id may arrive in UUID form.
 */
test("markPendingConsoleScrollbackEntriesUnknown keeps the row awaiting the user", () => {
  const kept = createPendingConsoleScrollbackEntry(
    "fixture 1 at 50",
    "a0b1c2d3e4f56789abcdef0123456789",
    10,
  );
  const other = createPendingConsoleScrollbackEntry("go 1", "1111", 11);

  const marked = markPendingConsoleScrollbackEntriesUnknown(
    [kept, other],
    "Result lost",
    "A0B1C2D3-E4F5-6789-ABCD-EF0123456789",
  );

  assert.equal(marked[0], kept);
  assert.equal(marked[1].status, "unknown");
});

/** Marking with nothing pending keeps the same array so the store does not notify. */
test("markPendingConsoleScrollbackEntriesUnknown returns the same array when nothing is pending", () => {
  const entries = [createImmediateErrorConsoleScrollbackEntry("noop", "x", 5)];
  assert.equal(
    markPendingConsoleScrollbackEntriesUnknown(entries, "Result lost"),
    entries,
  );
});
