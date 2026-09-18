// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ShowfileExportPolicy } from "./showfile-export-options";

export type DiagnosticLogMode = "all" | "recent" | "none";
export type DiagnosticShowfileMode = ShowfileExportPolicy | "none";

/** Bounded display fields extracted directly from the persisted tracing record. */
export interface DiagnosticLogEntry {
  timestamp: string;
  level: string;
  target: string;
  message: string;
  fields: { name: string; value: string }[];
  shortened: boolean;
}

/** One formatted page from a fixed boundary in the stored application log. */
export interface DiagnosticLogPage {
  entries: DiagnosticLogEntry[];
  nextOffset: number | null;
  fileLength: number;
}

/** A structured event read from the persisted tracing JSON log. */
export type DiagnosticLog = Record<string, unknown>;

export interface DiagnosticContext {
  version: string;
  buildId: string;
  backendVersion: string;
  runtime: string;
  connection: string;
  userAgent: string;
  logs: readonly DiagnosticLog[];
  logFileStatus:
    | "available"
    | "unavailable"
    | "not requested"
    | "not applicable";
}

/** Formats compact system information independently of log and showfile selections. */
export function formatSystemInfo(
  context: Omit<DiagnosticContext, "logs" | "logFileStatus">,
  collectedAt = new Date(),
): string {
  return JSON.stringify(
    {
      application: "Nightfall",
      collectedAt: collectedAt.toISOString(),
      frontendVersion: context.version,
      buildId: context.buildId,
      backendVersion: context.backendVersion || "Unavailable",
      runtime: context.runtime,
      connection: context.connection,
      userAgent: context.userAgent,
    },
    null,
    2,
  );
}
