// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { formatDiagnosticValue } from "./diagnostic-format";

/** Distinguishes thrown exceptions from promise rejections nobody handled. */
export type UncaughtErrorKind = "error" | "rejection";

/** Structured-clone-safe description of an uncaught failure. */
export interface UncaughtErrorDetails {
  kind: UncaughtErrorKind;
  name: string;
  message: string;
  stack?: string;
}

/** Worker-to-main message carrying an uncaught worker failure. */
export interface UncaughtErrorMessage {
  type: typeof UNCAUGHT_ERROR_MESSAGE_TYPE;
  error: UncaughtErrorDetails;
}

/** Event target and message port subset shared by dedicated worker scopes and test doubles. */
export interface UncaughtErrorScope {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  postMessage(message: UncaughtErrorMessage): void;
}

export const UNCAUGHT_ERROR_MESSAGE_TYPE = "uncaughtError";

/** Normalizes any thrown or rejected value into a structured-clone-safe description. */
export function describeUncaughtError(
  value: unknown,
  kind: UncaughtErrorKind,
): UncaughtErrorDetails {
  if (value instanceof Error) {
    return {
      kind,
      name: value.name || "Error",
      message: value.message,
      stack: value.stack,
    };
  }
  if (value && typeof value === "object" && "message" in value) {
    const { name, message, stack } = value as Record<string, unknown>;
    return {
      kind,
      name: typeof name === "string" && name ? name : "Error",
      message: formatDiagnosticValue(message),
      stack: typeof stack === "string" ? stack : undefined,
    };
  }
  return {
    kind,
    name: kind === "rejection" ? "Unhandled rejection" : "Error",
    message:
      value === undefined ? "Unknown error" : formatDiagnosticValue(value),
  };
}

/**
 * Describes an `error` event, falling back to its message and location when the
 * thrown value is unavailable (cross-origin scripts, worker load failures).
 */
export function describeErrorEvent(
  event: ErrorEvent,
  fallbackMessage = "Unknown error",
): UncaughtErrorDetails {
  if (event.error != null) return describeUncaughtError(event.error, "error");
  const details = describeUncaughtError(
    event.message || fallbackMessage,
    "error",
  );
  if (event.filename)
    details.stack = `    at ${event.filename}:${event.lineno}:${event.colno}`;
  return details;
}

/** Recognizes forwarded uncaught worker failures among a worker's other messages. */
export function isUncaughtErrorMessage(
  data: unknown,
): data is UncaughtErrorMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === UNCAUGHT_ERROR_MESSAGE_TYPE &&
    typeof (data as { error?: unknown }).error === "object"
  );
}

/**
 * Posts uncaught exceptions and unhandled rejections to the owning page, where
 * they can be shown to the user with their stack intact. The events are
 * cancelled so the browser does not also report them as unhandled.
 */
export function forwardUncaughtErrors(scope: UncaughtErrorScope): () => void {
  /** Forwards one failure, ignoring a port that can no longer post. */
  const forward = (error: UncaughtErrorDetails) => {
    try {
      scope.postMessage({ type: UNCAUGHT_ERROR_MESSAGE_TYPE, error });
    } catch {
      // Reporting must never raise another uncaught error from this handler.
    }
  };
  /** Forwards a thrown exception with its original stack. */
  const onError = (event: Event) => {
    event.preventDefault();
    forward(describeErrorEvent(event as ErrorEvent));
  };
  /** Forwards a rejection that would otherwise only reach the worker's console. */
  const onRejection = (event: Event) => {
    event.preventDefault();
    forward(
      describeUncaughtError(
        (event as PromiseRejectionEvent).reason,
        "rejection",
      ),
    );
  };
  scope.addEventListener("error", onError);
  scope.addEventListener("unhandledrejection", onRejection);
  return () => {
    scope.removeEventListener("error", onError);
    scope.removeEventListener("unhandledrejection", onRejection);
  };
}

/** Forwards uncaught failures when running inside a dedicated worker, and does nothing elsewhere. */
export function forwardWorkerUncaughtErrors(): void {
  const workerScope = (globalThis as { DedicatedWorkerGlobalScope?: unknown })
    .DedicatedWorkerGlobalScope;
  if (
    typeof workerScope === "function" &&
    globalThis instanceof (workerScope as typeof Object)
  )
    forwardUncaughtErrors(globalThis as unknown as UncaughtErrorScope);
}
