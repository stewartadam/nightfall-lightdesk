// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { XIcon } from "@squidlab/phosphor-solid/x";
import { invoke } from "@tauri-apps/api/core";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import Modal from "../../components/ui/modal";
import { ScrollArea } from "../../components/ui/scroll-area";
import Tooltip from "../../components/ui/tooltip";
import {
  type DiagnosticLogEntry,
  type DiagnosticLogMode,
  type DiagnosticLogPage,
  type DiagnosticShowfileMode,
  formatSystemInfo,
} from "../../lib/diagnostics";
import { exportDiagnostics } from "../../lib/diagnostics-export";
import { showfileExportOptions } from "../../lib/showfile-export-options";
import { collectSystemInfo } from "../../lib/system-info";
import { isTauriRuntime } from "../../lib/tauri";
import { activeShellDialog, closeDiagnostics } from "../../state/shell-dialog";

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
  const [copied, setCopied] = createSignal(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let copyButton: HTMLButtonElement | undefined;
  let downloadButton: HTMLButtonElement | undefined;
  let dialogElement: HTMLElement | undefined;
  let focusedDefault = false;
  let collectionId = 0;
  let previewElement: HTMLDivElement | undefined;

  /** Invalidates pending reads after the dialog is disposed. */
  onCleanup(() => {
    disposed = true;
    clearTimeout(copyTimer);
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
      await navigator.clipboard.writeText(systemInfo());
      if (disposed) return;
      setCopied(true);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => setCopied(false), 2000);
    } catch {
      setStatus(
        "Clipboard unavailable. Expand System info above to select and copy it.",
      );
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

  /** Routes Enter to Download while preserving explicitly focused controls and text selection. */
  createEffect(() => {
    if (!isOpen()) return;
    /** Keeps the default action inside this dialog without intercepting Cancel or Copy activation. */
    const handleDefaultAction = (event: KeyboardEvent) => {
      if (
        event.key !== "Enter" ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, summary, textarea, [contenteditable=true]"))
        return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void download();
    };
    document.addEventListener("keydown", handleDefaultAction, true);
    onCleanup(() =>
      document.removeEventListener("keydown", handleDefaultAction, true),
    );
  });

  const buttonClass =
    "rounded border border-neutral-600 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-700 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50";
  /** Styles the selected segment while keeping its radio input keyboard accessible. */
  const segmentClass = (selected: boolean) =>
    `relative cursor-pointer whitespace-nowrap rounded px-2.5 py-1 text-center text-sm has-focus-visible:ring-2 has-focus-visible:ring-blue-400 ${selected ? "bg-blue-600 text-white" : "text-neutral-300 hover:bg-neutral-800"}`;

  return (
    <Modal isOpen={isOpen()} onEscape={closeDiagnostics}>
      <div class="fixed inset-0 nightfall-top-layer flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
        <section
          ref={dialogElement}
          role="dialog"
          aria-modal="true"
          aria-label="Collect Diagnostics"
          class="nightfall-modal-surface flex h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 text-neutral-200 shadow-xl"
        >
          <div class="flex shrink-0 items-center justify-between border-b border-neutral-700 p-4">
            <h2 class="text-lg font-semibold">Collect Diagnostics</h2>
            <button
              type="button"
              aria-label="Close diagnostics"
              class={buttonClass}
              onClick={closeDiagnostics}
            >
              <XIcon class="size-4" aria-hidden />
            </button>
          </div>
          <div class="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <details class="shrink-0 text-sm text-neutral-300">
              <summary class="cursor-pointer">System info</summary>
              <textarea
                aria-label="System info"
                class="mt-2 h-24 resize-none w-full rounded border border-neutral-600 bg-neutral-950 p-3 font-mono text-xs leading-5"
                value={systemInfo()}
                readOnly
                spellcheck={false}
              />
            </details>
            <p class="text-sm text-neutral-300">
              Download a ZIP with system information and the content you select
              below. Review it before sharing; files stay on your computer until
              you attach them to a bug report.
            </p>
            <fieldset
              class="shrink-0 space-y-1"
              aria-describedby="diagnostic-showfile-description"
              disabled={saving()}
            >
              <legend class="sr-only">Showfile to include</legend>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  aria-hidden="true"
                  class="w-32 shrink-0 text-sm font-medium"
                >
                  Showfile to include
                </span>
                <div class="inline-flex flex-wrap gap-0.5 rounded-md border border-neutral-600 bg-neutral-950 p-0.5">
                  <For each={showfileModes}>
                    {(mode) => (
                      <label
                        class={segmentClass(showfileMode() === mode.value)}
                      >
                        <input
                          type="radio"
                          name="diagnostic-showfile-mode"
                          value={mode.value}
                          checked={showfileMode() === mode.value}
                          class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                          onChange={() => setShowfileMode(mode.value)}
                        />
                        {mode.label}
                      </label>
                    )}
                  </For>
                </div>
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
                <span
                  aria-hidden="true"
                  class="w-32 shrink-0 text-sm font-medium"
                >
                  Logs to include
                </span>
                <div class="inline-flex flex-wrap gap-0.5 rounded-md border border-neutral-600 bg-neutral-950 p-0.5">
                  <For each={logModes}>
                    {(mode) => (
                      <label class={segmentClass(logMode() === mode.value)}>
                        <input
                          type="radio"
                          name="diagnostic-log-mode"
                          value={mode.value}
                          checked={logMode() === mode.value}
                          class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                          onChange={() => {
                            setLogMode(mode.value);
                            void readLogs();
                          }}
                        />
                        {mode.label}
                      </label>
                    )}
                  </For>
                </div>
              </div>
              <p
                id="diagnostic-log-description"
                class="text-xs text-neutral-400 sm:pl-35"
              >
                {logDescriptions[logMode()]}
                <Show when={logMode() !== "none"}>
                  {" "}
                  Messages may contain file paths or show names. Check the
                  preview before sharing.
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
                            <span class="italic">{field.name}</span>=
                            {field.value}
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
          <div class="flex shrink-0 flex-wrap justify-between gap-2 border-t border-neutral-700 p-4">
            <div>
              <button
                ref={copyButton}
                type="button"
                class={buttonClass}
                onClick={() => void copySystemInfo()}
              >
                Copy System Info
              </button>
              <Show when={copied()}>
                <Tooltip
                  content={() => "System info copied."}
                  forceVisible={() => true}
                  anchorRect={() => copyButton?.getBoundingClientRect()}
                >
                  <span />
                </Tooltip>
              </Show>
            </div>
            <div class="flex gap-2">
              <button
                type="button"
                class={buttonClass}
                onClick={closeDiagnostics}
              >
                Cancel
              </button>
              <button
                ref={downloadButton}
                type="button"
                class="rounded border border-blue-500 bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={(collecting() && !page()) || saving()}
                onClick={() => void download()}
              >
                {saving() ? "Saving diagnostics…" : "Download Diagnostics"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
}
