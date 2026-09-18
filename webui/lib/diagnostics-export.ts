// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getBackendUrl } from "./api";
import type { DiagnosticLogMode, DiagnosticShowfileMode } from "./diagnostics";
import { isTauriRuntime } from "./tauri";

export interface DiagnosticBundleOptions {
  systemInfo: string;
  logMode: Exclude<DiagnosticLogMode, "none"> | null;
  logLength: number | null;
  showfileMode: DiagnosticShowfileMode;
}

/** Saves diagnostics through the native picker or downloads a ZIP from the connected backend. */
export async function exportDiagnostics(
  options: DiagnosticBundleOptions,
): Promise<string> {
  if (!isTauriRuntime()) {
    const response = await fetch(`${getBackendUrl()}/api/diagnostics/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInfo: options.systemInfo,
        showfileMode: options.showfileMode,
      }),
    });
    if (!response.ok)
      throw new Error(
        (await response.text()) || "Could not export diagnostics.",
      );
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nightfall-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
    anchor.click();
    // Allow the browser to acquire the download before releasing its blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return diagnosticWarningMessage(
      Number(response.headers.get("x-diagnostic-export-warnings") ?? 0),
    );
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<{ path: string; warnings: string[] } | null>(
    "export_diagnostics",
    { options },
  );
  if (!result) return "";
  return diagnosticWarningMessage(result.warnings.length);
}

/** Points users to the archive inventory when some selected assets could not be included. */
function diagnosticWarningMessage(warnings: number): string {
  return warnings
    ? `${warnings} file(s) could not be included; see manifest.json in the ZIP for details.`
    : "";
}
