// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createBugReport } from "./bug-report";
import { getLogger } from "./logger";
import { collectSystemInfo } from "./system-info";
import { isTauriRuntime } from "./tauri";
import { invokeTauriMenuAction } from "./tauri-menu";

const log = getLogger(import.meta.url);

export const FEEDBACK_URL = __NIGHTFALL_PROJECT_LINKS__.feedback;
export const BUG_REPORT_URL = __NIGHTFALL_PROJECT_LINKS__.bugReport;

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

/** Opens the reviewed summary in the configured issue form without submitting an issue. */
export async function openBugReport(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_bug_report", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
