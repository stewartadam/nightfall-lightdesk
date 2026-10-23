// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import { getLogger } from "./logger";
import { isTauriRuntime } from "./tauri";

const log = getLogger(import.meta.url);

/** Event the desktop shell emits whenever the update status changes. */
const UPDATE_STATE_EVENT = "nightfall:update-state";

/** Page with the latest installers, for builds that cannot install updates themselves. */
export const DOWNLOADS_URL = "https://nightfall.live/downloads";

/** Opens the downloads page in the system browser. */
export function openDownloadsPage(): void {
  window.open(DOWNLOADS_URL, "_blank", "noopener,noreferrer");
}

/** Where a desktop update stands, as reported by the desktop shell. */
export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing";

/**
 * What happens when a check finds a newer version: `notify` waits for the operator to download
 * it, `download` fetches it and waits for a restart, and `install` fetches it and installs it on
 * the next quit. Updates never install while the app is running.
 */
export type DesktopUpdateMode = "notify" | "download" | "install";

/** Update status owned by the desktop shell; only the desktop app's own window receives it. */
export interface DesktopUpdateState {
  /**
   * Whether this build can download and install updates itself; only published releases can.
   * Other builds still check, and send the operator to {@link DOWNLOADS_URL} for a newer version.
   */
  canInstall: boolean;
  /** Whether the operator allows checking the update service. */
  checkForUpdates: boolean;
  /** What happens when a check finds a newer version. */
  updateMode: DesktopUpdateMode;
  phase: DesktopUpdatePhase;
  /** Version found, being downloaded, or waiting to install. */
  version: string | null;
  /** How much of the update has downloaded, while downloading. */
  progress: DesktopUpdateProgress | null;
  /** Seconds since the Unix epoch of the last check that reached the update service. */
  lastCheckedAt: number | null;
  /** Why the last check, download, install or preference change failed. */
  error: DesktopUpdateError | null;
  /** Version this launch was updated to, set only on the first launch after an update. */
  updatedTo: string | null;
}

/**
 * What failed: checking the update service, downloading, installing the downloaded update (the
 * previous version kept running), or saving the update preferences.
 */
export type DesktopUpdateErrorKind =
  | "check"
  | "download"
  | "install"
  | "preferences";

/** A failed update step, with the underlying error kept for troubleshooting. */
export interface DesktopUpdateError {
  kind: DesktopUpdateErrorKind;
  /** The underlying error, shown on request. */
  details: string;
}

/** Bytes of an update downloaded so far. */
export interface DesktopUpdateProgress {
  downloadedBytes: number;
  /** Size of the package, when the update service reports it. */
  totalBytes: number | null;
}

/** Latest update status, or `null` outside the desktop app or before the shell answers. */
export const $desktopUpdate = atom<DesktopUpdateState | null>(null);

let started = false;

/**
 * Loads the update status from the desktop shell and follows its changes for the rest of the
 * page's life. Does nothing outside the desktop app, and only subscribes once per page.
 */
export async function startDesktopUpdates(): Promise<void> {
  if (started || !isTauriRuntime()) return;
  started = true;
  let unlisten: (() => void) | undefined;
  try {
    const [{ invoke }, { listen }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]);
    // Subscribing first means no change is missed; a change that arrives while the snapshot
    // is in flight is newer than the snapshot, so it is kept.
    let changed = false;
    unlisten = await listen<DesktopUpdateState>(UPDATE_STATE_EVENT, (event) => {
      changed = true;
      $desktopUpdate.set(event.payload);
    });
    const snapshot = await invoke<DesktopUpdateState>("update_state");
    if (!changed) $desktopUpdate.set(snapshot);
  } catch (error) {
    unlisten?.();
    started = false;
    log.warn("Could not read the desktop update status", { error });
  }
}

/** Turns automatic update checks on or off for this computer. */
export async function setDesktopUpdateChecks(enabled: boolean): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  $desktopUpdate.set(
    await invoke<DesktopUpdateState>("set_update_checks", { enabled }),
  );
}

/**
 * Chooses what happens when a check finds a newer version. Choosing a mode that downloads starts
 * downloading a version that is already waiting.
 */
export async function setDesktopUpdateMode(
  mode: DesktopUpdateMode,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  $desktopUpdate.set(
    await invoke<DesktopUpdateState>("set_update_mode", { mode }),
  );
}

/**
 * Checks for a newer version now and downloads it when there is one. Resolves once the check
 * and any download finish, and rejects while update checks are turned off. Every status change
 * arrives through {@link $desktopUpdate} as an event; the command's own result is not stored,
 * since it can arrive after a newer event, such as when a background check was already running.
 */
export async function checkForDesktopUpdates(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<DesktopUpdateState>("check_for_updates");
}

/**
 * Downloads the newer version a check found. Progress and the result arrive through
 * {@link $desktopUpdate} as events; rejects when no version is waiting to download.
 */
export async function downloadDesktopUpdate(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<DesktopUpdateState>("download_update");
}

/**
 * Quits so the downloaded update installs, then starts the new version. Work is saved as on any
 * other quit.
 */
export async function restartToUpdate(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_to_update");
}
