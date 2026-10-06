// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createBugReport } from "./bug-report";
import type { DiagnosticContext } from "./diagnostics";

const baseUrl =
  "https://github.com/example/project/issues/new?template=bug_report.yml";
const context: DiagnosticContext = {
  version: "0.1",
  buildId: "abc123",
  backendVersion: "",
  runtime: "Desktop",
  connection: "disconnected",
  userAgent: "Test OS",
  logFileStatus: "available",
  logs: [
    { level: "INFO", fields: { message: "routine info" } },
    {
      level: "WARN",
      target: "scanner",
      fields: { message: "warning &title=unexpected # 💡" },
    },
  ],
};

/** Prefill values round-trip through query encoding without modifying template or unrelated fields. */
test("prefills the issue form with version and selected recent problems", () => {
  const report = createBugReport(baseUrl, context, "all");
  const url = new URL(report.url);
  assert.equal(url.searchParams.get("template"), "bug_report.yml");
  assert.equal(url.searchParams.get("version"), "0.1 (abc123); Test OS");
  assert.equal(url.searchParams.get("system-information"), report.summary);
  assert.equal(url.searchParams.has("title"), false);
  const summary = JSON.parse(report.summary);
  assert.equal(summary.logs.length, 1);
  assert.equal(summary.logs[0].message, "warning &title=unexpected # 💡");
  assert.equal(summary.backendVersion, "Unavailable");
});

/** Log exclusion also applies to issue links, avoiding disclosure of hidden message content. */
test("none prefills only application details", () => {
  const report = createBugReport(baseUrl, context, "none");
  assert.deepEqual(JSON.parse(report.summary).logs, []);
  assert.equal(JSON.parse(report.summary).logFileStatus, "not requested");
  assert.ok(!report.summary.includes("warning &title"));
});

/** Large Unicode logs yield a bounded link, retaining newer problems and recording omissions. */
test("bounds encoded URLs and truncates long warning messages", () => {
  const logs = Array.from({ length: 100 }, (_, index) => ({
    level: "ERROR",
    target: "engine",
    fields: { message: `${index} ${"💡".repeat(5000)}` },
  }));
  const report = createBugReport(baseUrl, { ...context, logs }, "all");
  assert.ok(report.url.length <= 6000);
  const summary = JSON.parse(report.summary);
  assert.ok(summary.logs.length > 0);
  assert.ok(summary.logs.length <= 20);
  assert.match(summary.logs.at(-1).message, /^99 /);
  assert.equal(summary.omittedWarningsAndErrors, 100 - summary.logs.length);
  assert.ok(summary.logs.at(-1).message.endsWith("…"));
  assert.equal(
    new URL(report.url).searchParams.get("system-information"),
    report.summary,
  );
});

/** Unexpected errors prefill the title and description with the headline and stack. */
test("prefills an unexpected error's headline and stack", () => {
  const report = createBugReport(baseUrl, context, "none", {
    source: "engine runtime",
    name: "TypeError",
    message: "crypto.randomUUID is not a function",
    stack:
      "TypeError: crypto.randomUUID is not a function\n    at sendCommand (/lib/engine-runtime.ts:2941:30)",
  });
  const url = new URL(report.url);
  assert.equal(
    url.searchParams.get("title"),
    "[Bug] TypeError: crypto.randomUUID is not a function",
  );
  const problem = url.searchParams.get("problem") ?? "";
  assert.match(problem, /\(engine runtime\)/);
  assert.match(
    problem,
    /```\nTypeError: crypto\.randomUUID is not a function\n {4}at sendCommand \(\/lib\/engine-runtime\.ts:2941:30\)\n```/,
  );
});

/** Huge stacks are trimmed from the bottom so the link stays within its budget. */
test("trims long error stacks to fit the link budget", () => {
  const frames = Array.from(
    { length: 400 },
    (_, index) => `    at frame${index} (/assets/${"💡".repeat(20)}.js:1:1)`,
  ).join("\n");
  const report = createBugReport(baseUrl, context, "all", {
    source: "app",
    name: "Error",
    message: "boom",
    stack: `Error: boom\n${frames}`,
  });
  assert.ok(report.url.length <= 6000);
  const problem = new URL(report.url).searchParams.get("problem") ?? "";
  assert.match(problem, /at frame0 /);
  assert.ok(!problem.includes("frame399"));
});

/** Firefox and WebKit stacks hold frames only, so every line is kept beneath the headline. */
test("keeps frame-only stacks intact", () => {
  const report = createBugReport(baseUrl, context, "none", {
    source: "app",
    name: "TypeError",
    message: "Failed to resolve '@tauri-apps/api'",
    stack: "sendCommand@/lib/engine-runtime.ts:2941:30\n@/main.tsx:1:1",
  });
  const problem = new URL(report.url).searchParams.get("problem") ?? "";
  assert.ok(
    problem.includes(
      "```\nTypeError: Failed to resolve '@tauri-apps/api'\nsendCommand@/lib/engine-runtime.ts:2941:30\n@/main.tsx:1:1\n```",
    ),
  );
});
