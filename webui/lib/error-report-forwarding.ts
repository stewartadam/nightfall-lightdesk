// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getBackendUrl } from "./api";
import { shorten } from "./bug-report";
import { getLogger } from "./logger";
import { isEmbeddedDemoRuntime } from "./runtime-config";
import type { UncaughtErrorReport } from "./uncaught-error-reporter";

const log = getLogger(import.meta.url);

/** Engine endpoint that turns web UI failures into error reports. */
const CLIENT_ERROR_PATH = "/api/telemetry/client-error";
/**
 * Longest stack sent; the engine keeps only the frames it can use. With the
 * other fields capped too, the body stays under the 64 KB keepalive limit.
 */
const MAX_STACK_LENGTH = 16_000;
/** Longest source, name or message sent; the engine keeps less. */
const MAX_FIELD_LENGTH = 4_000;

/**
 * Hands a failure to the engine, which reports it only while the operator shares error
 * reports and queues it while offline. The engine alone decides, so failures from before the
 * consent state reaches the page are judged the same way as later ones. The browser demo has
 * no engine, so its failures are not forwarded.
 */
export function forwardUncaughtError(
  report: UncaughtErrorReport,
  fatal: boolean,
): void {
  try {
    if (isEmbeddedDemoRuntime()) return;
    void fetch(`${getBackendUrl()}${CLIENT_ERROR_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        source: shorten(report.source, MAX_FIELD_LENGTH),
        kind: report.kind,
        name: shorten(report.name, MAX_FIELD_LENGTH),
        message: shorten(report.message, MAX_FIELD_LENGTH),
        stack:
          report.stack === undefined
            ? undefined
            : shorten(report.stack, MAX_STACK_LENGTH),
        fatal,
      }),
    }).catch((error: unknown) => {
      log.debug("Could not forward an uncaught error to the engine", { error });
    });
  } catch (error) {
    // Forwarding must never stop the failure from being shown.
    log.debug("Could not forward an uncaught error to the engine", { error });
  }
}
