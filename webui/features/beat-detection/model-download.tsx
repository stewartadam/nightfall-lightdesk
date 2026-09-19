// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CheckCircleIcon } from "@squidlab/phosphor-solid/check-circle";
import { createSignal, onCleanup, Show } from "solid-js";
import notice from "../../assets/models/beat-this/NOTICE.md?raw";
import {
  DialogBackdrop,
  DialogBody,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../components/ui/dialog";
import Modal from "../../components/ui/modal";
import { Button } from "../../components/ui/visual-language/button";
import { getBackendUrl } from "../../lib/api";

interface ModelStatus {
  phase:
    | "unchecked"
    | "checking"
    | "missing"
    | "downloading"
    | "cancelling"
    | "deleting"
    | "ready"
    | "failed"
    | "cancelled";
  received_bytes: number;
  total_bytes: number;
  error: string | null;
}

/** Owns a consent dialog while the connected backend owns the persistent model download. */
export function createBeatModelDownload() {
  const [open, setOpen] = createSignal(false);
  const [status, setStatus] = createSignal<ModelStatus>();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let readyAction: (() => void) | undefined;

  /** Stop polling and discard an authoring action when its dialog is dismissed. */
  const close = () => {
    generation++;
    clearTimeout(timer);
    readyAction = undefined;
    setOpen(false);
    setBusy(false);
  };
  onCleanup(close);

  /** Read or update model installation state without allowing stale requests to reopen a dialog. */
  const refresh = async (
    method = "GET",
    requestGeneration = generation,
    resource = "",
  ) => {
    clearTimeout(timer);
    setBusy(true);
    try {
      const response = await fetch(
        `${getBackendUrl()}/api/beat-detection/model${resource}`,
        { method, cache: "no-store" },
      );
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "Beat detection downloads are unavailable on this backend."
            : (await response.text()) ||
                "Could not contact the model download service.",
        );
      const next = (await response.json()) as ModelStatus;
      if (requestGeneration !== generation) return;
      setStatus(next);
      setError(next.error ?? undefined);
      if (next.phase === "ready" && readyAction) {
        const action = readyAction;
        close();
        action();
        return;
      }
      if (
        readyAction &&
        !["unchecked", "checking", "deleting"].includes(next.phase)
      ) {
        setOpen(true);
      }
      if (
        [
          "unchecked",
          "checking",
          "downloading",
          "cancelling",
          "deleting",
        ].includes(next.phase)
      ) {
        timer = setTimeout(() => void refresh("GET", requestGeneration), 500);
      }
    } catch (failure) {
      if (requestGeneration === generation) {
        setError(failure instanceof Error ? failure.message : String(failure));
        if (readyAction) setOpen(true);
      }
    } finally {
      if (requestGeneration === generation) setBusy(false);
    }
  };

  /** Check availability on explicit user action; downloading still requires its own consent button. */
  const request = (onReady?: () => void) => {
    generation++;
    clearTimeout(timer);
    readyAction = onReady;
    setStatus(undefined);
    setError(undefined);
    setOpen(!onReady);
    void refresh();
  };

  /** Render availability, explicit consent, transfer controls, and the complete local license notice. */
  const dialog = (usePortal = true) => (
    <Modal isOpen={open()} onEscape={close} usePortal={usePortal}>
      <DialogBackdrop
        role="dialog"
        aria-modal="true"
        aria-label="Beat detection model"
        class="nightfall-top-layer"
      >
        <DialogSurface
          role="document"
          style={{ width: "560px", "max-width": "100%", "max-height": "85vh" }}
        >
          <DialogHeader>
            <DialogTitle>Beat detection model</DialogTitle>
          </DialogHeader>
          <DialogBody class="space-y-4 overflow-y-auto">
            <p>
              Would you like to download the{" "}
              <span class="text-[var(--accent)]">Beat This</span> model (~83 MB)
              to detect beats in audio? Your existing beat grids and playback
              continue to work without it.
            </p>
            <p class="text-sm text-neutral-400">
              The model will be saved to application data on this machine and
              available for offline use after downloading. You can also download
              it later from the Settings pane.
            </p>
            <Show when={status()?.phase === "ready"}>
              <p role="status" class="flex items-center gap-2">
                <CheckCircleIcon
                  class="size-5 shrink-0 text-green-400"
                  aria-hidden
                />
                Model installed. Beat detection is ready offline.
              </p>
            </Show>
            <Show
              when={
                !status() || ["unchecked", "checking"].includes(status()!.phase)
              }
            >
              <p role="status">Checking model availability…</p>
            </Show>
            <Show
              when={
                status()?.phase === "downloading" ||
                status()?.phase === "cancelling"
              }
            >
              <div role="status">
                <p>
                  {status()?.phase === "cancelling"
                    ? "Cancelling download…"
                    : "Downloading beat detection model…"}
                </p>
                <progress
                  class="w-full"
                  aria-label="Model download progress"
                  value={status()?.received_bytes ?? 0}
                  max={status()?.total_bytes ?? 83077778}
                />
                <p class="text-sm">
                  {((status()?.received_bytes ?? 0) / 1000000).toFixed(1)} /{" "}
                  {((status()?.total_bytes ?? 83077778) / 1000000).toFixed(1)}{" "}
                  MB
                </p>
              </div>
            </Show>
            <Show when={status()?.phase === "cancelled"}>
              <p role="status">
                Download cancelled. You can retry whenever you need beat
                detection.
              </p>
            </Show>
            <Show when={error()}>
              <p role="alert" class="text-red-400">
                {error()}
              </p>
            </Show>
            <details>
              <summary class="cursor-pointer">
                Beat This license and attribution (MIT)
              </summary>
              <div class="ml-4">
                <p class="my-2 text-sm">
                  <a
                    href="https://github.com/CPJKU/beat_this"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline"
                  >
                    Beat This project
                  </a>{" "}
                  ·{" "}
                  <a
                    href="https://github.com/mosynthkey/beat_this_cpp"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline"
                  >
                    ONNX conversion
                  </a>
                </p>
                <pre class="max-h-56 overflow-y-auto whitespace-pre-wrap rounded border border-neutral-700 p-3 text-xs">
                  {notice}
                </pre>
              </div>
            </details>
            <div class="flex justify-end gap-2">
              <Button onClick={close}>Back</Button>
              <Show when={status()?.phase === "downloading"}>
                <Button
                  disabled={busy()}
                  onClick={() => void refresh("DELETE")}
                >
                  Cancel download
                </Button>
              </Show>
              <Show
                when={
                  status() &&
                  ["missing", "failed", "cancelled"].includes(status()!.phase)
                }
              >
                <Button disabled={busy()} onClick={() => void refresh("POST")}>
                  {status()?.phase === "missing"
                    ? "Download model"
                    : "Retry download"}
                </Button>
              </Show>
              <Show
                when={
                  error() &&
                  (!status() ||
                    !["missing", "failed", "cancelled"].includes(
                      status()!.phase,
                    ))
                }
              >
                <Button disabled={busy()} onClick={() => void refresh()}>
                  Retry connection
                </Button>
              </Show>
            </div>
          </DialogBody>
        </DialogSurface>
      </DialogBackdrop>
    </Modal>
  );
  return {
    request,
    dialog,
    isOpen: open,
    status,
    error,
    busy,
    refresh,
    close,
    /** Remove cached weights independently of transfer cancellation. */
    remove: () => refresh("DELETE", generation, "/cache"),
  };
}
