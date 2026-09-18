// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Returns whether the UI is running inside the Tauri desktop shell. */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined"
  );
}

/** Detects the current browser or Node platform identifier. */
function detectPlatform(): string {
  if (typeof navigator !== "undefined") {
    const navigatorWithUserAgentData = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    return (
      navigatorWithUserAgentData.userAgentData?.platform ??
      navigator.platform ??
      ""
    );
  }

  // Avoid referencing the Node global directly; this file is typechecked for the browser app.
  const runtimeProcess = (
    globalThis as typeof globalThis & {
      process?: { platform?: string };
    }
  ).process;
  if (typeof runtimeProcess?.platform === "string") {
    return runtimeProcess.platform;
  }

  return "";
}

/** Resolves the Nightfall app data directory from an env override or platform default. */
export function resolveNightfallDataDirectoryPath(
  platform: string,
  envDataDir?: string,
): string {
  const envOverride = envDataDir?.trim();
  if (envOverride) {
    return envOverride;
  }

  const normalizedPlatform = platform.toLowerCase();

  if (normalizedPlatform.includes("mac") || normalizedPlatform === "darwin") {
    return "~/Library/Application Support/com.nightfall.nightfall";
  }

  if (normalizedPlatform.includes("win") || normalizedPlatform === "win32") {
    return "%APPDATA%\\nightfall";
  }

  if (normalizedPlatform.includes("linux")) {
    return "~/.local/share/nightfall";
  }

  throw new Error("Unsupported platform for Nightfall data directory path");
}

/** Returns the Nightfall app data directory path visible to the current UI runtime. */
export function getNightfallDataDirectoryPath(): string {
  const env = (
    import.meta as ImportMeta & {
      env?: { NIGHTFALL_DATA_DIR?: string };
    }
  ).env;
  return resolveNightfallDataDirectoryPath(
    detectPlatform(),
    env?.NIGHTFALL_DATA_DIR,
  );
}

/** Opens the active Nightfall app data directory in the desktop shell. */
export async function openDataDirectory(): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error(
      "Data directory access is only available in the desktop app.",
    );
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_data_dir");
  log.info("Opened Nightfall data directory");
}
