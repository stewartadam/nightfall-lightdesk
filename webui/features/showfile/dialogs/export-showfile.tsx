// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  Show,
} from "solid-js";
import { Alert } from "../../../components/ui/alert";
import {
  Dialog,
  DialogBody,
  DialogCancelButton,
  DialogFooter,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/visual-language/button";
import { getLogger } from "../../../lib/logger";
import { exportShowfile } from "../../../lib/showfile-export";
import {
  type ShowfileExportPolicy,
  showfileExportOptions,
} from "../../../lib/showfile-export-options";
import { currentShowfileName } from "../../../lib/showfile-loading";
import { isTauriRuntime } from "../../../lib/tauri";
import { pushToast } from "../../../state/notifications";

const log = getLogger(import.meta.url);

/**
 * Exports an independent showfile copy with selectable assets. A completed export closes the
 * dialog (warnings follow as a toast), while a failure keeps it open with the error in place.
 */
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

  /** Starts each export with the current show's name and the complete reference policy. */
  createEffect(() => {
    if (!props.open) return;
    setName(`${currentShowfileName.get()}-export`);
    setPolicy("allReferences");
    setError("");
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

  /**
   * Runs the export once. Native picker cancellation leaves the dialog unchanged, success closes
   * it and reports any warnings as a toast, and failure keeps it open showing the error.
   */
  const submit = async () => {
    if (busy() || !validName()) return;
    setBusy(true);
    setError("");
    let completed: Awaited<ReturnType<typeof exportShowfile>>;
    try {
      completed = await exportShowfile(name().trim(), policy());
    } catch (error) {
      log.error("Could not export showfile", { error });
      setError(String(error));
      return;
    } finally {
      setBusy(false);
    }
    if (!completed) return;
    if (completed.warnings.length > 0) {
      pushToast("warning", completed.warnings.join("; "), undefined, [], {
        title: "Showfile exported with warnings",
      });
    }
    props.onClose();
  };

  return (
    <Dialog
      kind="task"
      isOpen={props.open}
      title="Export Showfile"
      closeLabel="Close export showfile dialog"
      class="max-w-xl"
      busy={busy()}
      onDismiss={close}
    >
      <form
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
              The local date and time (YYYYMMDD-HHMMSS) are added to the export
              name.{" "}
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
            <Alert variant="caution" density="compact" role="alert">
              <p>{error()}</p>
            </Alert>
          </Show>
        </DialogBody>
        <DialogFooter>
          <DialogCancelButton />
          <Button
            type="submit"
            variant="primary"
            disabled={busy() || !validName()}
          >
            {busy() ? "Exporting…" : desktop ? "Save" : "Download Showfile"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
