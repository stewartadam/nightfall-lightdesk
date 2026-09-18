// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { forwardDiagnosticConsole } from "./diagnostic-console";

/** Forwarding preserves original console arguments and serializes errors and circular metadata. */
test("forwards each console level without altering output or truncating arguments", () => {
  const calls: unknown[][] = [];
  const forwarded: { level: string; message: string }[] = [];
  /** Records original console arguments to verify unchanged console behavior. */
  const original = (...args: unknown[]) => {
    calls.push(args);
  };
  const levels = ["log", "info", "debug", "trace", "warn", "error"] as const;
  const target = Object.fromEntries(
    levels.map((level) => [level, original]),
  ) as unknown as Console;
  const restore = forwardDiagnosticConsole(target, async (level, message) => {
    forwarded.push({ level, message });
  });
  const cyclic: Record<string, unknown> = { count: 12n };
  cyclic.self = cyclic;
  const error = new Error("browser failure");
  for (const level of levels)
    target[level](level, cyclic, error, "💡".repeat(3000));
  assert.deepEqual(
    forwarded.map((entry) => entry.level),
    levels,
  );
  assert.equal(calls[0][1], cyclic);
  assert.equal(calls[0][2], error);
  assert.match(forwarded[0].message, /Circular/);
  assert.match(forwarded[0].message, /browser failure/);
  assert.match(forwarded[0].message, /stack/);
  assert.ok(forwarded[0].message.endsWith("💡".repeat(3000)));
  restore();
  assert.equal(target.warn, original);
});

/** Native transport failures cannot break console output or generate unhandled rejection loops. */
test("isolates native forwarding failures", async () => {
  let calls = 0;
  const target = Object.fromEntries(
    ["log", "info", "debug", "trace", "warn", "error"].map((level) => [
      level,
      () => {
        calls++;
      },
    ]),
  ) as unknown as Console;
  const restore = forwardDiagnosticConsole(target, async () => {
    throw new Error("IPC unavailable");
  });
  assert.doesNotThrow(() => target.warn("warning"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  restore();
});

/** Uncaught errors and promise failures use the same transport and release their listeners. */
test("forwards uncaught browser events until disposed", () => {
  const events = new EventTarget();
  const messages: string[] = [];
  const target = Object.fromEntries(
    ["log", "info", "debug", "trace", "warn", "error"].map((level) => [
      level,
      () => {},
    ]),
  ) as unknown as Console;
  const restore = forwardDiagnosticConsole(
    target,
    async (level, message) => {
      assert.equal(level, "error");
      messages.push(message);
    },
    events as unknown as Window,
  );
  const error = Object.assign(new Event("error"), {
    error: new Error("uncaught failure"),
  });
  const rejection = Object.assign(new Event("unhandledrejection"), {
    reason: "promise failure",
  });
  events.dispatchEvent(error);
  events.dispatchEvent(rejection);
  assert.match(messages[0], /uncaught failure/);
  assert.equal(messages[1], "promise failure");
  restore();
  events.dispatchEvent(error);
  assert.equal(messages.length, 2);
});
