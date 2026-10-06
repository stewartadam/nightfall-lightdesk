// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { openDiagnostics } from "../state/shell-dialog";
import {
  type BugReportError,
  formatErrorHeadline,
  shorten,
} from "./bug-report";
import { getLogger } from "./logger";
import type { ToastAction } from "./notification-queue";
import { isTauriRuntime } from "./tauri";
import {
  describeErrorEvent,
  describeUncaughtError,
  isUncaughtErrorMessage,
  type UncaughtErrorDetails,
  type UncaughtErrorKind,
} from "./uncaught-error";

const log = getLogger(import.meta.url);

/**
 * Identical failures within this window are not shown again, so a failing loop
 * shows one notification. It outlasts the toast itself, which stays reachable
 * with its actions in notification history.
 */
export const REPEAT_SUPPRESSION_MS = 60_000;
/** How long the notification stays up while not hovered or focused. */
const TOAST_DURATION_MS = 30_000;
const MAX_TRACKED_FAILURES = 100;
const MAX_HEADLINE_LENGTH = 300;
/** Browser noise that does not indicate a Nightfall defect. */
const IGNORED_MESSAGES = [/^ResizeObserver loop/, /^Script error\.?$/];

/** An uncaught failure ready to show and to prefill into a bug report. */
export interface UncaughtErrorReport extends BugReportError {
  kind: UncaughtErrorKind;
}

interface UncaughtErrorReporterOptions {
  present: (report: UncaughtErrorReport) => void;
  now?: () => number;
}

/**
 * Creates the reporting policy shared by the page and its workers: drops browser
 * noise and presents each distinct failure at most once per suppression window.
 */
export function createUncaughtErrorReporter(
  options: UncaughtErrorReporterOptions,
): (source: string, details: UncaughtErrorDetails) => void {
  const now = options.now ?? Date.now;
  const lastPresented = new Map<string, number>();
  return (source, details) => {
    if (IGNORED_MESSAGES.some((pattern) => pattern.test(details.message)))
      return;
    const key = `${source}\n${details.name}\n${details.message}`;
    const time = now();
    const previous = lastPresented.get(key);
    if (previous !== undefined && time - previous < REPEAT_SUPPRESSION_MS)
      return;
    lastPresented.delete(key);
    lastPresented.set(key, time);
    if (lastPresented.size > MAX_TRACKED_FAILURES)
      lastPresented.delete(lastPresented.keys().next().value as string);
    options.present({ ...details, source });
  };
}

/**
 * Shows an error notification offering a prefilled bug report. Both modules load
 * before the toast appears so Report Bug opens the form within the click, where
 * browsers allow new windows.
 */
function presentUncaughtError(report: UncaughtErrorReport): void {
  void Promise.all([import("../state/notifications"), import("./feedback")])
    .then(([{ pushToast }, { openErrorBugReport }]) => {
      const actions: ToastAction[] = [
        { label: "Report Bug", onClick: () => openErrorBugReport(report) },
      ];
      // Stored logs are only collectable by the desktop application.
      if (isTauriRuntime())
        actions.push({
          label: "Collect Diagnostics",
          onClick: openDiagnostics,
          dismissOnClick: false,
        });
      pushToast(
        "error",
        shorten(formatErrorHeadline(report), MAX_HEADLINE_LENGTH),
        TOAST_DURATION_MS,
        actions,
        { title: "Something went wrong" },
      );
    })
    .catch((error: unknown) => {
      log.error("Could not show the uncaught error notification", { error });
    });
}

/** Reports a failure from the page or one of its workers to the user. */
export const reportUncaughtError = createUncaughtErrorReporter({
  present: presentUncaughtError,
});

/** Shows uncaught exceptions and unhandled rejections from the page itself. */
export function reportWindowUncaughtErrors(target: Window): () => void {
  /** Reports a thrown exception; the browser still logs it to the console. */
  const onError = (event: ErrorEvent) =>
    reportUncaughtError("app", describeErrorEvent(event));
  /** Reports a rejection nobody handled; the browser still logs it to the console. */
  const onRejection = (event: PromiseRejectionEvent) =>
    reportUncaughtError(
      "app",
      describeUncaughtError(event.reason, "rejection"),
    );
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/**
 * Shows failures forwarded by a worker (see `forwardWorkerUncaughtErrors`) and
 * errors the worker could not forward itself, such as failing to load. The
 * optional callback lets the owner react, for example by failing pending work.
 */
export function watchWorkerUncaughtErrors(
  worker: Worker,
  source: string,
  onFailure?: (details: UncaughtErrorDetails) => void,
): () => void {
  /** Logs and reports one failure; forwarded failures never reach the console otherwise. */
  const handle = (details: UncaughtErrorDetails) => {
    log.error(`Uncaught ${details.kind} in ${source}`, { error: details });
    reportUncaughtError(source, details);
    onFailure?.(details);
  };
  /** Picks forwarded failures out of the worker's ordinary message stream. */
  const onMessage = (event: MessageEvent) => {
    if (isUncaughtErrorMessage(event.data)) handle(event.data.error);
  };
  /**
   * Handles failures raised outside the worker's own forwarding, cancelling the
   * event so browsers do not report it again as a failure of the page itself.
   */
  const onError = (event: Event) => {
    event.preventDefault();
    handle(
      describeErrorEvent(event as ErrorEvent, `The ${source} stopped working`),
    );
  };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  return () => {
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
  };
}
