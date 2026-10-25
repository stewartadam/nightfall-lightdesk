// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { APP_VERSION } from "./app-metadata";
import { type BugReportError, createBugReport } from "./bug-report";
import { documentationUrl } from "./documentation-url";
import { getLogger } from "./logger";
import { collectSystemInfo } from "./system-info";
import { isTauriRuntime } from "./tauri";
import { invokeTauriMenuAction, TAURI_MENU_ACTIONS } from "./tauri-menu";

const log = getLogger(import.meta.url);

export const FEEDBACK_URL = __NIGHTFALL_PROJECT_LINKS__.feedback;
export const BUG_REPORT_URL = __NIGHTFALL_PROJECT_LINKS__.bugReport;

/**
 * Opens the user guide for this app version. The desktop app asks the native shell, which fills
 * in the same address and opens it in the system browser.
 */
export function openDocumentation(): void {
  if (isTauriRuntime()) {
    void invokeTauriMenuAction(TAURI_MENU_ACTIONS.documentation).catch(
      (error: unknown) => {
        log.error("Could not open the user guide", { error });
      },
    );
    return;
  }
  const url = documentationUrl(
    __NIGHTFALL_PROJECT_LINKS__.documentation,
    APP_VERSION,
  );
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Opens an issue form with compact system information for bugs or a blank form for feedback. */
export function openFeedbackPage(kind: "feedback" | "bug"): void {
  if (kind === "bug") {
    const report = createBugReport(BUG_REPORT_URL, collectSystemInfo(), "none");
    void openBugReport(report.url).catch((error: unknown) => {
      log.error("Could not open the bug report", { error });
    });
    return;
  }
  if (isTauriRuntime()) {
    void invokeTauriMenuAction("app.feedback").catch((error: unknown) => {
      log.error("Could not open the project issue form", { error });
    });
    return;
  }
  window.open(FEEDBACK_URL, "_blank", "noopener,noreferrer");
}

/**
 * Opens the bug report form prefilled with an unexpected error's headline and
 * stack. The page origin is removed from the message and stack, which keeps the
 * link short and leaves local network addresses out of the public issue.
 */
export function openErrorBugReport(error: BugReportError): void {
  try {
    const origin = window.location.origin;
    /** Removes this page's origin, leaving site-relative URLs. */
    const scrub = (text: string) =>
      origin === "null" ? text : text.split(origin).join("");
    const report = createBugReport(
      BUG_REPORT_URL,
      collectSystemInfo(),
      "none",
      {
        ...error,
        message: scrub(error.message),
        stack: error.stack === undefined ? undefined : scrub(error.stack),
      },
    );
    void openBugReport(report.url).catch((cause: unknown) => {
      log.error("Could not open the bug report", { error: cause });
    });
  } catch (cause) {
    log.error("Could not prepare the bug report", { error: cause });
    // The prefilled form failed, so fall back to the blank one.
    void openBugReport(BUG_REPORT_URL).catch(() => {});
  }
}

/** Opens the reviewed summary in the configured issue form without submitting an issue. */
export async function openBugReport(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_bug_report", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
