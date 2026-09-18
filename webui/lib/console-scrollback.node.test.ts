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
