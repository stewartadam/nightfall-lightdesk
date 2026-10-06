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

let workspaceVisible = false;
let workspaceShown = false;
let plainFatalErrorShown = false;

/**
 * How an error that blocks the application is presented: `recoverable` errors
 * may leave a working application behind the dialog, while others leave
 * nothing usable, so the dialog offers no way to continue.
 */
export interface FatalErrorPresentation {
  report: UncaughtErrorReport;
  recoverable: boolean;
  afterStartup: boolean;
}

/** Titles a blocking error dialog by whether startup finished and whether the app survived. */
export function fatalErrorTitle(failure: FatalErrorPresentation): string {
  if (failure.recoverable) return "Something went wrong";
  return failure.afterStartup
    ? "Nightfall stopped working"
    : "Nightfall couldn't start";
}

/**
 * Records whether the workspace is on screen. While it is not (startup,
 * startup prompts, or a showfile load behind the splash), notifications would
 * be hidden behind the splash or a modal prompt, so uncaught failures open the
 * blocking error dialog instead.
 */
export function setWorkspaceVisible(visible: boolean): void {
  workspaceVisible = visible;
  if (visible) workspaceShown = true;
}

/**
 * Writes a bare-bones failure notice into the page when the error dialog
 * itself cannot load, for example because the failure was a missing chunk.
 */
function renderPlainFatalError(failure: FatalErrorPresentation): void {
  if (plainFatalErrorShown) return;
  plainFatalErrorShown = true;
  const { report } = failure;
  const notice = document.createElement("div");
  notice.setAttribute("role", "alert");
  notice.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;background:#0a0a0a;color:#e5e5e5;font:14px system-ui,sans-serif;text-align:center";
  const title = document.createElement("strong");
  title.textContent = fatalErrorTitle(failure);
  const detail = document.createElement("code");
  detail.textContent = formatErrorHeadline(report);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => window.location.reload());
  notice.append(title, detail, reload);
  document.body.append(notice);
}

/** Shows a failure in the blocking error dialog, falling back to a plain notice. */
function presentFatalError(
  report: UncaughtErrorReport,
  recoverable: boolean,
): void {
  const failure = { report, recoverable, afterStartup: workspaceShown };
  void import("../components/shell/app/fatal-error-dialog")
    .then(({ showFatalError }) => showFatalError(failure))
    .catch((error: unknown) => {
      log.error("Could not show the fatal error dialog", { error });
      renderPlainFatalError(failure);
    });
}

/** Reports a failure from the page or one of its workers to the user. */
export const reportUncaughtError = createUncaughtErrorReporter({
  present: (report) =>
    workspaceVisible
      ? presentUncaughtError(report)
      : presentFatalError(report, true),
});

/**
 * Reports a failure that leaves the application unusable whenever it happens,
 * such as the workspace failing to load, initialize or render.
 */
export function reportFatalError(source: string, error: unknown): void {
  const details = describeUncaughtError(error, "error");
  log.error(`Fatal error in ${source}`, { error: details });
  presentFatalError({ ...details, source }, false);
}

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
