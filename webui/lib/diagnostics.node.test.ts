// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type DiagnosticContext, formatSystemInfo } from "./diagnostics";

const context: DiagnosticContext = {
  version: "0.1.0",
  buildId: "abcdef0",
  backendVersion: "",
  runtime: "Desktop",
  connection: "disconnected",
  userAgent: "Test browser",
  logs: [
    {
      level: "WARN",
      target: "engine",
      fields: { message: "/private/show failed", code: 42 },
    },
  ],
  logFileStatus: "available",
};

/** System info stays compact and excludes logs even if the source context contains sensitive messages. */
test("system info includes platform and offline connection metadata only", () => {
  const text = formatSystemInfo(context, new Date(0));
  const report = JSON.parse(text);
  assert.equal(report.application, "Nightfall");
  assert.equal(report.backendVersion, "Unavailable");
  assert.equal(report.frontendVersion, context.version);
  assert.equal(report.connection, "disconnected");
  assert.equal(report.collectedAt, new Date(0).toISOString());
  assert.equal("logs" in report, false);
  assert.equal("logRetention" in report, false);
  assert.equal(text.includes("/private/"), false);
});
