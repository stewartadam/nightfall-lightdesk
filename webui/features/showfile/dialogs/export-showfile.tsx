// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { XIcon } from "@squidlab/phosphor-solid/x";
import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  Show,
} from "solid-js";
import { DialogBody } from "../../../components/ui/dialog";
import Modal from "../../../components/ui/modal";
import { getLogger } from "../../../lib/logger";
import {
  exportShowfile,
  type ShowfileExportResult,
} from "../../../lib/showfile-export";
import {
  type ShowfileExportPolicy,
  showfileExportOptions,
} from "../../../lib/showfile-export-options";
import { currentShowfileName } from "../../../lib/showfile-loading";
import { isTauriRuntime } from "../../../lib/tauri";

const log = getLogger(import.meta.url);

/** Exports an independent showfile copy with selectable assets and visible completion or failure details. */
export function ExportShowfileModal(props: {
  open: boolean;
  onClose: () => void;
}) {
  const titleId = createUniqueId();
  const nameId = createUniqueId();
  const desktop = isTauriRuntime();
  const [name, setName] = createSignal("");
  const [policy, setPolicy] =
    createSignal<ShowfileExportPolicy>("allReferences");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [result, setResult] = createSignal<ShowfileExportResult | null>(null);

  /** Starts each export with the current show's name and the complete reference policy. */
  createEffect(() => {
    if (!props.open) return;
    setName(`${currentShowfileName.get()}-export`);
    setPolicy("allReferences");
    setError("");
    setResult(null);
  });

  /** Keeps the export dialog present until native selection and disk writes have finished. */
  const close = () => {
    if (!busy()) props.onClose();
  };

  /** Rejects paths so the native folder picker remains the sole destination selector. */
  const validName = () => {
    const value = name().trim();
    return (
      value.length > 0 &&
      value !== "." &&
      value !== ".." &&
      !/[\\/]/.test(value)
    );
  };

  /** Runs the export once, treating native picker cancellation as an unchanged dialog. */
  const submit = async () => {
    if (busy() || !validName()) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await exportShowfile(name().trim(), policy()));
    } catch (error) {
      log.error("Could not export showfile", { error });
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={props.open} onEscape={close} closeOnEscape={!busy()}>
      <div class="fixed inset-0 nightfall-top-layer flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy={busy()}
          class="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 text-neutral-200 shadow-xl"
        >
          <header class="flex shrink-0 items-center justify-between border-b border-neutral-700 px-4 py-3">
            <h2 id={titleId} class="text-lg font-semibold">
              Export Showfile
            </h2>
            <button
              type="button"
              aria-label="Close export showfile dialog"
              onClick={close}
              disabled={busy()}
              class="rounded p-2 hover:bg-neutral-800 disabled:opacity-50"
            >
              <XIcon class="size-4" aria-hidden />
            </button>
          </header>
          <form
            class="flex min-h-0 flex-col overflow-hidden"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogBody class="space-y-5">
              <p class="text-sm text-neutral-400">
                Create a separate copy of your current show, including unsaved
                changes.
              </p>
              <div class="space-y-2">
                <label for={nameId} class="block text-sm font-medium">
                  Export name
                </label>
                <input
                  id={nameId}
                  value={name()}
                  onInput={(event) => setName(event.currentTarget.value)}
                  disabled={busy()}
                  required
                  class="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p class="text-xs text-neutral-400">
                  The local date and time (YYYYMMDD-HHMMSS) are added to the
                  export name.{" "}
                  {desktop
                    ? "A .nightfall-show folder will be created in the folder you choose."
                    : "Download a ZIP, then extract its .nightfall-show folder to open the exported show."}
                </p>
              </div>
              <fieldset disabled={busy()} class="space-y-2">
                <legend class="mb-2 text-sm font-medium">
                  References to include
                </legend>
                <For each={showfileExportOptions}>
                  {(option) => (
                    <label class="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-700 p-3 has-checked:border-blue-500 has-checked:bg-blue-950/30">
                      <input
                        type="radio"
                        aria-label={option.label}
                        name={`${titleId}-policy`}
                        value={option.value}
                        checked={policy() === option.value}
                        onChange={() => setPolicy(option.value)}
                        class="mt-1 accent-blue-500"
                      />
                      <span>
                        <span class="block text-sm font-medium">
                          {option.label}
                        </span>
                        <span class="mt-1 block text-xs text-neutral-400">
                          {option.description}
                        </span>
                      </span>
                    </label>
                  )}
                </For>
              </fieldset>
              <Show when={error()}>
                <p role="alert" class="text-sm text-red-400">
                  {error()}
                </p>
              </Show>
              <Show when={result()}>
                {(completed) => (
                  <div role="status" class="space-y-2 text-sm">
                    <p class="break-all text-green-400">
                      {desktop ? "Exported to " : "Download started: "}
                      {completed().path}
                    </p>
                    <Show when={completed().warnings.length > 0}>
                      <p class="text-amber-300">
                        The export completed with warnings:
                      </p>
                      <ul class="list-disc space-y-1 pl-5 text-amber-300">
                        <For each={completed().warnings}>
                          {(warning) => <li class="break-words">{warning}</li>}
                        </For>
                      </ul>
                    </Show>
                  </div>
                )}
              </Show>
            </DialogBody>
            <footer class="flex shrink-0 justify-end gap-2 border-t border-neutral-700 px-4 py-3">
              <button
                type="button"
                onClick={close}
                disabled={busy()}
                class="rounded-lg border border-neutral-700 px-3 py-2 text-sm hover:bg-neutral-800 disabled:opacity-50"
              >
                {result() ? "Close" : "Cancel"}
              </button>
              <button
                type="submit"
                disabled={busy() || !validName()}
                class="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy()
                  ? "Exporting…"
                  : desktop
                    ? "Choose Folder…"
                    : "Download Showfile"}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </Modal>
  );
}
