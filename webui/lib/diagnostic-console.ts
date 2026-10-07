// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { isTauri } from "@tauri-apps/api/core";
import { debug, error, info, trace, warn } from "@tauri-apps/plugin-log";
import { formatDiagnosticValue } from "./diagnostic-format";

export type ConsoleLogLevel =
  | "log"
  | "info"
  | "debug"
  | "trace"
  | "warn"
  | "error";
type ForwardLog = (level: ConsoleLogLevel, message: string) => Promise<void>;

/** Forwards console calls and uncaught errors directly to native logging without retaining events. */
export function forwardDiagnosticConsole(
  target: Console,
  forward: ForwardLog,
  events?: Window,
): () => void {
  const levels = ["log", "info", "debug", "trace", "warn", "error"] as const;
  const originals = levels.map((level) => target[level]);
  /** Isolates logging transport failures from console output and avoids rejection loops. */
  const send = (level: ConsoleLogLevel, args: unknown[]) => {
    try {
      void forward(level, args.map(formatDiagnosticValue).join(" ")).catch(
        () => {},
      );
    } catch {
      // Diagnostic forwarding must not interrupt the application or original console output.
    }
  };
  for (const [index, level] of levels.entries()) {
    const original = originals[index];
    /** Preserves the original console output while submitting the same arguments to tracing. */
    target[level] = (...args: unknown[]) => {
      original.apply(target, args);
      send(level, args);
    };
  }
  /** Forwards uncaught JavaScript errors which do not call console.error. */
  const onError = (event: ErrorEvent) =>
    send("error", [event.error ?? event.message]);
  /** Forwards unhandled promise failures without changing browser error handling. */
  const onRejection = (event: PromiseRejectionEvent) =>
    send("error", [event.reason]);
  events?.addEventListener("error", onError);
  events?.addEventListener("unhandledrejection", onRejection);
  /** Releases console overrides and event listeners during hot reload. */
  return () => {
    levels.forEach((level, index) => {
      target[level] = originals[index];
    });
    events?.removeEventListener("error", onError);
    events?.removeEventListener("unhandledrejection", onRejection);
  };
}

if (isTauri()) {
  const nativeLoggers = { log: info, info, debug, trace, warn, error };
  const dispose = forwardDiagnosticConsole(
    console,
    (level, message) => nativeLoggers[level](message),
    window,
  );
  import.meta.hot?.dispose(dispose);
}
