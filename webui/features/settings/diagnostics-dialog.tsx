// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { invoke } from "@tauri-apps/api/core";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import {
  Dialog,
  DialogCancelButton,
  DialogFooter,
} from "../../components/ui/dialog";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SegmentedControl } from "../../components/ui/segmented-control";
import Tooltip from "../../components/ui/tooltip";
import { Button } from "../../components/ui/visual-language/button";
import { writeClipboardText } from "../../lib/clipboard";
import {
  type DiagnosticLogEntry,
  type DiagnosticLogMode,
  type DiagnosticLogPage,
  type DiagnosticShowfileMode,
  formatSystemInfo,
} from "../../lib/diagnostics";
import { exportDiagnostics } from "../../lib/diagnostics-export";
import { PRIVACY_CONTACT_EMAIL } from "../../lib/privacy";
import { showfileExportOptions } from "../../lib/showfile-export-options";
import { collectSystemInfo } from "../../lib/system-info";
import { isTauriRuntime } from "../../lib/tauri";
import { activeShellDialog, closeDiagnostics } from "../../state/shell-dialog";

/** Status shown when System Info cannot be copied, so it can be withdrawn after a later copy works. */
const CLIPBOARD_UNAVAILABLE_STATUS =
  "Clipboard unavailable. Expand System information included above to select and copy it.";

const logModes = [
  { value: "none", label: "None" },
  { value: "recent", label: "Recent warnings/errors" },
  { value: "all", label: "All logs" },
] as const;
const showfileModes = [
  { value: "none", label: "None" },
  { value: "showfileOnly", label: "Without references" },
  { value: "showfileReferences", label: "Local references" },
  { value: "allReferences", label: "All references" },
] as const;
const logDescriptions: Record<DiagnosticLogMode, string> = {
  all: "Includes all backend and browser console logs stored for this application session.",
  recent:
    "Includes the latest 20 warnings/errors from the stored application log.",
  none: "Excludes stored logs.",
};
const showfileDescriptions: Record<DiagnosticShowfileMode, string> = {
  ...(Object.fromEntries(
    showfileExportOptions.map((option) => [option.value, option.description]),
  ) as Record<Exclude<DiagnosticShowfileMode, "none">, string>),
  none: "Excludes the showfile and its referenced data.",
};

const levelColors: Record<string, string> = {
  ERROR: "text-red-400",
  WARN: "text-yellow-400",
  INFO: "text-green-400",
  DEBUG: "text-violet-400",
  TRACE: "text-cyan-400",
};

/** Previews stored logs and exports an archive with explicitly selected showfile content. */
export function DiagnosticsDialog() {
  const activeDialog = useStore(activeShellDialog);
  /** Tracks diagnostic visibility across startup and interactive shell roots. */
  const isOpen = () => activeDialog() === "diagnostics";
  const [systemInfo, setSystemInfo] = createSignal("");
  const [logMode, setLogMode] = createSignal<DiagnosticLogMode>("recent");
  const [showfileMode, setShowfileMode] =
    createSignal<DiagnosticShowfileMode>("none");
  const [page, setPage] = createSignal<DiagnosticLogPage>();
  const [preview, setPreview] = createSignal<DiagnosticLogEntry[]>([]);
  const [collecting, setCollecting] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [logError, setLogError] = createSignal("");
  const [status, setStatus] = createSignal("");
  /** Counts System Info copies; each change flashes the confirmation tooltip. */
  const [copies, setCopies] = createSignal(0);
  let copyButton: HTMLButtonElement | undefined;
  let downloadButton: HTMLButtonElement | undefined;
  let dialogElement: HTMLDivElement | undefined;
  let focusedDefault = false;
  let collectionId = 0;
  let previewElement: HTMLDivElement | undefined;

  /** Invalidates pending reads after the dialog is disposed. */
  onCleanup(() => {
    collectionId++;
  });

  /** Loads a bounded page on demand, preserving the original file boundary while scrolling. */
  const readLogs = async (append = false) => {
    if (append && (collecting() || page()?.nextOffset == null)) return;
    const id = append ? collectionId : ++collectionId;
    const mode = logMode();
    const previous = append ? page() : undefined;
    if (!append) {
      setPage(undefined);
      setPreview([]);
      setLogError("");
      setStatus("");
      if (previewElement) previewElement.scrollTop = 0;
    }
    setCollecting(false);
    if (mode === "none") return;
    if (!isTauriRuntime()) {
      setLogError(
        "Log file collection is available in the desktop application.",
      );
      return;
    }
    setCollecting(true);
    try {
      const result = await invoke<DiagnosticLogPage>(
        "collect_diagnostic_logs",
        {
          mode,
          offset: previous?.nextOffset ?? null,
          fileLength: previous?.fileLength ?? null,
        },
      );
      if (id !== collectionId) return;
      setPage(result);
      setPreview((entries) =>
        append ? [...entries, ...result.entries] : result.entries,
      );
    } catch {
      if (id !== collectionId) return;
      setLogError(
        "The log file is unavailable. System information and selected showfile content can still be downloaded.",
      );
    } finally {
      if (id === collectionId) setCollecting(false);
    }
  };

  /** Starts each dialog with recent warnings/errors and no showfile, releasing previews on close. */
  createEffect(() => {
    if (!isOpen()) {
      collectionId++;
      setPreview([]);
      setPage(undefined);
      return;
    }
    setLogMode("recent");
    setShowfileMode("none");
    setSystemInfo(untrack(() => formatSystemInfo(collectSystemInfo())));
    void untrack(() => readLogs());
  });

  /** Copies only compact platform and connection details, independently of the archive selections. */
  const copySystemInfo = async () => {
    try {
      await writeClipboardText(systemInfo());
      setCopies((count) => count + 1);
      // Withdraw an earlier copy failure, leaving any other status in place.
      if (status() === CLIPBOARD_UNAVAILABLE_STATUS) setStatus("");
    } catch {
      setStatus(CLIPBOARD_UNAVAILABLE_STATUS);
    }
  };

  /** Downloads a ZIP and keeps errors visible without discarding the selected preview. */
  const download = async () => {
    if (saving() || (collecting() && !page())) return;
    setSaving(true);
    setStatus("");
    const mode = logMode();
    try {
      setStatus(
        await exportDiagnostics({
          systemInfo: systemInfo(),
          logMode: mode === "none" ? null : mode,
          logLength: page()?.fileLength ?? null,
          showfileMode: showfileMode(),
        }),
      );
    } catch (error) {
      setStatus(`Could not save diagnostics: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  /** Gives the primary action initial focus once its preview is ready, without stealing later focus. */
  createEffect(() => {
    if (!isOpen() || collecting() || focusedDefault) return;
    const frame = requestAnimationFrame(() => {
      focusedDefault = true;
      if (!dialogElement?.contains(document.activeElement))
        downloadButton?.focus();
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  return (
    <Dialog
      kind="task"
      isOpen={isOpen()}
      title="Collect Diagnostics"
      closeLabel="Close diagnostics"
      class="h-[calc(100dvh-32px)] max-w-5xl"
      surfaceRef={(element) => {
        dialogElement = element;
      }}
      onDismiss={closeDiagnostics}
      onSubmit={() => void download()}
    >
      <div class="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <p class="text-sm text-neutral-300">
          Generating a diagnostic bundle can help Nightfall authors troubleshoot
          and reproduce your issue. It includes information from your logs and
          showfile.
        </p>
        <p class="text-sm text-neutral-300">
          The diagnostic bundle is saved on this computer until you share it,{" "}
          <strong>and may contain personal information</strong> such as
          usernames, file paths or object labels, along with showfile data like
          audio and GDTF files.
        </p>
        <p class="text-sm text-neutral-300">
          Bug reports are public GitHub issues that can be viewed by anyone.
          Review the ZIP contents carefully before attaching it, or email it
          privately to{" "}
          <a
            class="text-blue-300 underline"
            href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
          >
            {PRIVACY_CONTACT_EMAIL}
          </a>
          . Private submissions are used only to look into the problem you
          reported and are deleted within 30 days after use.
        </p>

        <div class="my-1 border-t border-slate-200 dark:border-slate-600" />

        <details class="shrink-0 text-sm text-neutral-300">
          <summary class="cursor-pointer text-sm font-medium">
            System information included
          </summary>
          <textarea
            aria-label="System information included"
            class="mt-2 h-24 resize-none w-full rounded border border-neutral-600 bg-neutral-950 p-3 font-mono text-xs leading-5"
            value={systemInfo()}
            readOnly
            spellcheck={false}
          />
        </details>

        <fieldset
          class="shrink-0 space-y-1"
          aria-describedby="diagnostic-showfile-description"
          disabled={saving()}
        >
          <legend class="sr-only">Showfile to include</legend>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span aria-hidden="true" class="w-32 shrink-0 text-sm font-medium">
              Showfile to include
            </span>
            <SegmentedControl
              label="Showfile to include"
              options={showfileModes}
              value={showfileMode()}
              disabled={saving()}
              onChange={setShowfileMode}
            />
          </div>
          <p
            id="diagnostic-showfile-description"
            class="text-xs text-neutral-400 sm:pl-35"
          >
            {showfileDescriptions[showfileMode()]}
          </p>
        </fieldset>
        <fieldset
          class="shrink-0 space-y-1"
          aria-describedby="diagnostic-log-description"
          disabled={saving()}
        >
          <legend class="sr-only">Logs to include</legend>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span aria-hidden="true" class="w-32 shrink-0 text-sm font-medium">
              Logs to include
            </span>
            <SegmentedControl
              label="Logs to include"
              options={logModes}
              value={logMode()}
              disabled={saving()}
              onChange={(mode) => {
                setLogMode(mode);
                void readLogs();
              }}
            />
          </div>
          <p
            id="diagnostic-log-description"
            class="text-xs text-neutral-400 sm:pl-35"
          >
            {logDescriptions[logMode()]}
            <Show when={logMode() !== "none"}>
              {" "}
              Messages may contain file paths or show names. Check the preview
              before sharing.
            </Show>
          </p>
        </fieldset>
        <div class="flex min-h-0 flex-1 flex-col gap-2">
          <h3 class="text-sm font-medium">Log preview</h3>
          <ScrollArea
            class="min-h-0 w-full flex-1 rounded border border-neutral-600 bg-neutral-950"
            viewportClass="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-neutral-200"
            viewportProps={{
              ref: (element) => {
                previewElement = element;
              },
              role: "region",
              "aria-label": "Log preview",
              tabIndex: 0,
              "aria-busy": collecting(),
              onScroll: (event) => {
                const element = event.currentTarget;
                if (
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  160
                )
                  void readLogs(true);
              },
            }}
          >
            <Show when={logError()}>
              <span class="block text-amber-300">{logError()}</span>
            </Show>
            <For
              each={preview()}
              fallback={
                collecting()
                  ? "Reading log file…"
                  : logMode() === "none"
                    ? "No logs selected."
                    : logError()
                      ? null
                      : "No matching log messages."
              }
            >
              {(entry) => (
                <span class="block" data-log-level={entry.level}>
                  <span class="text-neutral-500">
                    {entry.timestamp}
                    {entry.timestamp ? " " : ""}
                  </span>
                  <span
                    class={`font-semibold ${levelColors[entry.level] ?? "text-neutral-400"}`}
                  >
                    {entry.level.padStart(5)}
                  </span>{" "}
                  <span class="text-neutral-500">{entry.target}: </span>
                  <span>{entry.message}</span>
                  <For each={entry.fields}>
                    {(field) => (
                      <span>
                        {" "}
                        <span class="italic">{field.name}</span>={field.value}
                      </span>
                    )}
                  </For>
                  <Show when={entry.shortened}>
                    <span class="text-neutral-500">
                      {" "}
                      … [preview shortened; full entry in ZIP]
                    </span>
                  </Show>
                </span>
              )}
            </For>
          </ScrollArea>
          <Show when={page()?.nextOffset != null}>
            <p class="text-xs text-neutral-400">
              {collecting()
                ? "Reading more log messages…"
                : "Scroll to read more. The ZIP includes all selected messages."}
            </p>
          </Show>
        </div>
        <Show when={status()}>
          <p role="status" class="break-words text-sm text-neutral-300">
            {status()}
          </p>
        </Show>
      </div>
      <DialogFooter class="justify-between">
        <div>
          <Button
            ref={copyButton}
            type="button"
            onClick={() => void copySystemInfo()}
          >
            Copy System Info
          </Button>
          <Tooltip
            content={() => "✅ System info copied."}
            flash={copies}
            anchorRect={() => copyButton?.getBoundingClientRect()}
          >
            <span />
          </Tooltip>
        </div>
        <div class="flex gap-2">
          <DialogCancelButton />
          <Button
            ref={downloadButton}
            type="button"
            variant="primary"
            disabled={(collecting() && !page()) || saving()}
            onClick={() => void download()}
          >
            {saving() ? "Saving diagnostics…" : "Download Diagnostics"}
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  );
}
