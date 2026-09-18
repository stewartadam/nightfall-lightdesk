// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { lazy, onCleanup, onMount, Show } from "solid-js";
import { getLogger } from "../../../lib/logger";
import { registerTauriMenuListener } from "../../../lib/tauri-menu";
import {
  activeShellDialog,
  openDiagnostics,
} from "../../../state/shell-dialog";

const log = getLogger(import.meta.url);

/** Loads the diagnostic presentation only when requested, keeping startup imports light. */
const DiagnosticsDialog = lazy(async () => ({
  default: (await import("../../../features/settings")).DiagnosticsDialog,
}));

/** Keeps native diagnostic collection available independently of engine startup. */
export default function DiagnosticsRuntime() {
  const activeDialog = useStore(activeShellDialog);
  /** Registers diagnostics immediately and releases late listeners after disposal. */
  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void registerTauriMenuListener({
      openDiagnostics,
      /** Loads issue reporting on demand so the splash keeps a lightweight listener. */
      reportBug: () => {
        void import("../../../lib/feedback").then(({ openFeedbackPage }) =>
          openFeedbackPage("bug"),
        );
      },
    })
      .then((handler) => {
        if (disposed) handler();
        else unlisten = handler;
      })
      .catch((error: unknown) => {
        log.error("Failed to register diagnostic menu listener:", { error });
      });
    onCleanup(() => {
      disposed = true;
      unlisten?.();
    });
  });

  return (
    <Show when={activeDialog() === "diagnostics"}>
      <DiagnosticsDialog />
    </Show>
  );
}
