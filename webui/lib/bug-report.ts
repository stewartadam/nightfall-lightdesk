// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DiagnosticContext, DiagnosticLogMode } from "./diagnostics";

const MAX_BUG_REPORT_URL_LENGTH = 6000;
const MAX_ERROR_STACK_LENGTH = 2000;

/** An unexpected failure the user is reporting, prefilled into the issue title and description. */
export interface BugReportError {
  /** Where the failure happened, such as the main thread or a named worker. */
  source: string;
  name: string;
  message: string;
  stack?: string;
}

/** Bounds individual fields without splitting Unicode code points. */
export function shorten(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const points = Array.from(text);
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : text;
}

/** Formats an error headline the way browsers print uncaught exceptions. */
export function formatErrorHeadline(error: BugReportError): string {
  return error.message ? `${error.name}: ${error.message}` : error.name;
}

/** Describes the failure in the issue body, keeping the stack below the given length. */
function describeError(error: BugReportError, stackLimit: number): string {
  const fullHeadline = formatErrorHeadline(error);
  const headline = shorten(fullHeadline, 500);
  const stack = error.stack ?? "";
  // V8 stacks start with the headline; Firefox and WebKit stacks hold frames only.
  const frames = stack.startsWith(fullHeadline)
    ? stack.slice(fullHeadline.length).replace(/^\n/, "")
    : stack;
  const trimmed = stackLimit > 0 ? shorten(frames, stackLimit) : "";
  return [
    `Nightfall reported an unexpected error (${error.source}):`,
    "",
    "```",
    trimmed ? `${headline}\n${trimmed}` : headline,
    "```",
    "",
    "What were you doing when this happened?",
  ].join("\n");
}

/** Builds a compact, reviewable issue-form summary that fits within the encoded URL budget. */
export function createBugReport(
  baseUrl: string,
  context: DiagnosticContext,
  mode: DiagnosticLogMode,
  error?: BugReportError,
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
  if (error)
    url.searchParams.set(
      "title",
      `[Bug] ${shorten(formatErrorHeadline(error), 120)}`,
    );
  let stackLimit = MAX_ERROR_STACK_LENGTH;
  while (true) {
    if (error)
      url.searchParams.set("problem", describeError(error, stackLimit));
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
    if (logs.length > 0) {
      logs.shift();
    } else if (error && stackLimit > 0) {
      // Trim from the bottom so the frames nearest the throw survive longest.
      stackLimit = stackLimit > 250 ? Math.floor(stackLimit / 2) : 0;
    } else {
      throw new Error(
        "System Information summary exceeds the bug report link limit",
      );
    }
  }
}
