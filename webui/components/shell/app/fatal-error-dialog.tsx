// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { formatErrorHeadline } from "../../../lib/bug-report";
import { openErrorBugReport } from "../../../lib/feedback";
import { isTauriRuntime } from "../../../lib/tauri";
import {
  type FatalErrorPresentation,
  fatalErrorTitle,
} from "../../../lib/uncaught-error-reporter";
import { openDiagnostics } from "../../../state/shell-dialog";
import { Dialog, DialogBody, DialogFooter } from "../../ui/dialog";
import { Button } from "../../ui/visual-language/button";

const [failure, setFailure] = createSignal<FatalErrorPresentation | null>(null);
let mounted = false;

/** Explains the failure in one sentence fitting when it happened and whether the app survived. */
function failureSummary(current: FatalErrorPresentation): string {
  if (!current.afterStartup)
    return "An unexpected error happened while Nightfall was starting.";
  return current.recoverable
    ? "An unexpected error happened while loading."
    : "An unexpected error stopped the workspace.";
}

/**
 * Explains a failure that stopped startup or the workspace, or that happened
 * while nothing else could show it, offering a reload and a prefilled bug
 * report. Recoverable failures can also be dismissed to keep working.
 */
function FatalErrorDialog() {
  /** Reloads the page, which restarts the engine connection and showfile load. */
  const reload = () => window.location.reload();
  return (
    <Show when={failure()}>
      {(current) => (
        <Dialog
          kind="required"
          isOpen
          title={fatalErrorTitle(current())}
          onSubmit={reload}
          class="max-w-xl"
        >
          <DialogBody class="space-y-3 text-sm text-neutral-300">
            <p>
              {failureSummary(current())} Reloading usually recovers. Reporting
              it helps us fix it.
            </p>
            <p
              class="rounded-md border border-red-800/70 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200 [overflow-wrap:anywhere]"
              role="alert"
            >
              {formatErrorHeadline(current().report)}
            </p>
            <Show when={current().report.stack}>
              {(stack) => (
                <details class="text-xs text-neutral-400">
                  <summary class="cursor-pointer">Technical details</summary>
                  <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-neutral-700 bg-neutral-950 p-2 font-mono [overflow-wrap:anywhere]">
                    {stack()}
                  </pre>
                </details>
              )}
            </Show>
          </DialogBody>
          <DialogFooter class="justify-between">
            <div class="flex gap-2">
              <Show when={current().recoverable}>
                <Button type="button" onClick={() => setFailure(null)}>
                  Continue Anyway
                </Button>
              </Show>
            </div>
            <div class="flex gap-2">
              {/* Stored logs are only collectable by the desktop application. */}
              <Show when={isTauriRuntime()}>
                <Button type="button" onClick={openDiagnostics}>
                  Collect Diagnostics
                </Button>
              </Show>
              <Button
                type="button"
                onClick={() => openErrorBugReport(current().report)}
              >
                Report Bug
              </Button>
              <Button
                type="button"
                variant="primary"
                autofocus
                onClick={reload}
              >
                Reload
              </Button>
            </div>
          </DialogFooter>
        </Dialog>
      )}
    </Show>
  );
}

/**
 * Shows the error dialog in its own root, so it appears even when the
 * application root failed to render. The first failure stays on screen until
 * the user acts on it, except that an unrecoverable failure replaces a
 * recoverable one so the dialog never offers to continue into a broken app.
 */
export function showFatalError(next: FatalErrorPresentation): void {
  const current = failure();
  if (current && (!current.recoverable || next.recoverable)) return;
  setFailure(next);
  if (mounted) return;
  mounted = true;
  const host = document.createElement("div");
  host.className = "contents";
  host.dataset.fatalErrorRoot = "true";
  document.body.append(host);
  render(() => <FatalErrorDialog />, host);
}
