// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { AppLifecyclePhase } from "../../../state/app-lifecycle";

export type StartupPhase =
  | "waiting"
  | "checking"
  | "prompting"
  | "loading-draft"
  | "loading-saved"
  | "ready";

/** Returns whether the current lifecycle phase should render the startup splash. */
export function shouldShowStartupSplash(
  phase: AppLifecyclePhase,
  hold: boolean,
): boolean {
  return (
    hold ||
    phase === "runtime-initializing" ||
    phase === "backend-connecting" ||
    phase === "startup-checking-draft" ||
    phase === "startup-loading-draft" ||
    phase === "startup-loading-saved"
  );
}

/** Maps the app lifecycle into the compact startup splash status vocabulary. */
export function startupPhaseForLifecycle(
  phase: AppLifecyclePhase,
): StartupPhase {
  switch (phase) {
    case "runtime-initializing":
    case "backend-connecting":
      return "waiting";
    case "startup-checking-draft":
      return "checking";
    case "startup-draft-prompt":
    case "startup-showfile-prompt":
      return "prompting";
    case "startup-loading-draft":
      return "loading-draft";
    case "startup-loading-saved":
      return "loading-saved";
    case "interactive":
      return "ready";
  }
}
