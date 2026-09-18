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
