// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getBackendUrl } from "./api";
import { currentShowfileSaveOptions } from "./showfile-actions";
import type { ShowfileExportPolicy } from "./showfile-export-options";
import { isTauriRuntime } from "./tauri";

export interface ShowfileExportResult {
  path: string;
  warnings: string[];
}

/** Exports live show state and UI layout with a local timestamp matching the backup filename format. */
export async function exportShowfile(
  name: string,
  policy: ShowfileExportPolicy,
): Promise<ShowfileExportResult | null> {
  const now = new Date();
  const [month, day, hours, minutes, seconds] = [
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ].map((value) => String(value).padStart(2, "0"));
  const timestamp = `${now.getFullYear()}${month}${day}-${hours}${minutes}${seconds}`;
  const exportName = `${name.trim().replace(/\.nightfall-show$/, "")}-${timestamp}`;
  const options = {
    name: exportName,
    policy,
    saveOptions: currentShowfileSaveOptions(),
  };
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ShowfileExportResult | null>("export_showfile", options);
  }
  const response = await fetch(
    `${getBackendUrl()}/api/showfiles/current/export`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    },
  );
  if (!response.ok)
    throw new Error((await response.text()) || "Could not export showfile.");
  const blob = await response.blob();
  const path = `${exportName}.nightfall-show.zip`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = path;
  anchor.click();
  // Allow the browser to acquire the download before releasing its blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  const warnings = Number(
    response.headers.get("x-showfile-export-warnings") ?? 0,
  );
  return {
    path,
    warnings:
      warnings > 0
        ? [
            `${warnings} export warning(s). See export-warnings.json in the ZIP for details.`,
          ]
        : [],
  };
}
