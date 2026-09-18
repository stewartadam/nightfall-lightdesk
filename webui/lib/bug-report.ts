// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DiagnosticContext, DiagnosticLogMode } from "./diagnostics";

const MAX_BUG_REPORT_URL_LENGTH = 6000;

/** Bounds individual fields without splitting Unicode code points. */
function shorten(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const points = Array.from(text);
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : text;
}

/** Builds a compact, reviewable issue-form summary that fits within the encoded URL budget. */
export function createBugReport(
  baseUrl: string,
  context: DiagnosticContext,
  mode: DiagnosticLogMode,
): { url: string; summary: string } {
  const problems =
    mode === "none"
      ? []
      : context.logs.filter(
          (entry) => entry.level === "WARN" || entry.level === "ERROR",
        );
  const logs = problems.slice(-20).map((entry) => {
    const fields = entry.fields as Record<string, unknown> | undefined;
    return {
      level: entry.level,
      target: shorten(entry.target, 100),
      message: shorten(fields?.message, 200),
    };
  });
  const metadata = {
    frontendVersion: shorten(context.version, 80),
    buildId: shorten(context.buildId, 80),
    backendVersion: shorten(context.backendVersion || "Unavailable", 80),
    runtime: shorten(context.runtime, 80),
    connection: shorten(context.connection, 80),
    userAgent: shorten(context.userAgent, 200),
    logFileStatus: mode === "none" ? "not requested" : context.logFileStatus,
  };
  const url = new URL(baseUrl);
  url.searchParams.set(
    "version",
    `${metadata.frontendVersion} (${metadata.buildId}); ${metadata.userAgent}`,
  );
  while (true) {
    const summary = JSON.stringify(
      {
        ...metadata,
        logs,
        summaryNote:
          mode === "none"
            ? "System Information only. Attach a diagnostic ZIP for logs and optional showfile content."
            : "Recent warnings/errors only; messages may be shortened. Attach the downloaded diagnostics for full details.",
        omittedWarningsAndErrors: problems.length - logs.length,
      },
      null,
      2,
    );
    url.searchParams.set("system-information", summary);
    if (url.href.length <= MAX_BUG_REPORT_URL_LENGTH)
      return { url: url.href, summary };
    if (logs.length === 0)
      throw new Error(
        "System Information summary exceeds the bug report link limit",
      );
    logs.shift();
  }
}
