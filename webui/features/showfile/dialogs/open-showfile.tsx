// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { CaretRightIcon } from "@squidlab/phosphor-solid/caret-right";
import { CopyIcon } from "@squidlab/phosphor-solid/copy";
import { FilePlusIcon } from "@squidlab/phosphor-solid/file-plus";
import { FolderOpenIcon } from "@squidlab/phosphor-solid/folder-open";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../../components/ui/dialog";
import { SearchPickerOption } from "../../../components/ui/search-picker";
import Tooltip from "../../../components/ui/tooltip";
import { Button } from "../../../components/ui/visual-language/button";
import { getBackendUrl } from "../../../lib/api";
import { getLogger } from "../../../lib/logger";
import {
  type OpenShowfileSelection,
  promptForNewShowfile,
} from "../../../lib/showfile-actions";
import { pushToast } from "../../../state/appStores";
import {
  type AvailableShowfile,
  type AvailableShowfilesResponse,
  draftShowfileName,
  formatModifiedTime,
  hasSavedShowfileRevision,
  modifiedTimeMs,
  mostRecentlyUpdatedShowfileNames,
  savedShowfileRevisionName,
  showfileGroupModifiedTimeMs,
  showfileLoadError,
  showfileRevisionPathLabel,
} from "../model/showfile-discovery";

const log = getLogger(import.meta.url);

interface OpenShowfileModalProps {
  open: boolean;
  onClose: () => void;
  onOpen: (selection: OpenShowfileSelection) => Promise<void> | void;
}

/** Renders a copyable explanation that a discovered snapshot cannot be loaded. */
const ShowfileLoadErrorBadge: Component<{ error: string }> = (props) => {
  /** Copies the complete parser diagnostic and reports clipboard failures. */
  const copyError = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!navigator?.clipboard?.writeText) {
      pushToast("error", "Clipboard access unavailable");
      return;
    }

    try {
      await navigator.clipboard.writeText(props.error);
      pushToast("success", "Copied showfile error");
    } catch (caught) {
      log.error("failed to copy showfile load error", caught);
      pushToast("error", "Could not copy showfile error");
    }
  };

  return (
    <Tooltip
      interactive
      content={() => (
        <span class="flex max-w-[min(36rem,calc(100vw-2rem))] items-start gap-2 whitespace-normal text-left normal-case">
          <span class="select-text break-words font-mono leading-relaxed">
            {props.error}
          </span>
          <Button
            size="icon"
            variant="subtle"
            type="button"
            aria-label="Copy showfile error"
            onClick={(event) => void copyError(event)}
          >
            <CopyIcon class="size-3.5" aria-hidden />
          </Button>
        </span>
      )}
    >
      <Button
        size="compact"
        variant="danger"
        type="button"
        aria-label={`Copy showfile error: ${props.error}`}
        onClick={(event) => void copyError(event)}
      >
        Error
      </Button>
    </Tooltip>
  );
};

/** Render the available showfiles picker dialog. */
export function OpenShowfileModal(props: OpenShowfileModalProps) {
  const [showfiles, setShowfiles] = createSignal<AvailableShowfile[]>([]);
  const [expandedShowfiles, setExpandedShowfiles] = createSignal<Set<string>>(
    new Set(),
  );
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  let abortController: AbortController | undefined;

  /** Fetch showfiles from the backend discovery endpoint. */
  const loadShowfiles = async () => {
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    setIsLoading(true);
    setError(undefined);

    try {
      const response = await fetch(`${getBackendUrl()}/api/showfiles`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = (await response.json()) as AvailableShowfilesResponse;
      setShowfiles(body.showfiles ?? []);
      setExpandedShowfiles(new Set<string>());
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      log.warn("failed to load available showfiles", caught);
      setShowfiles([]);
      setError("Could not load showfiles.");
    } finally {
      if (abortController === controller) {
        setIsLoading(false);
      }
    }
  };

  /** Refresh the available showfile list whenever the dialog opens. */
  createEffect(() => {
    if (!props.open) {
      abortController?.abort();
      return;
    }
    void loadShowfiles();
  });

  onCleanup(() => abortController?.abort());

  /** Toggle the displayed backup revision list for one showfile. */
  const toggleExpanded = (name: string) => {
    setExpandedShowfiles((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  /** Send the selected showfile or revision through the load flow. */
  const openSelection = async (selection: OpenShowfileSelection) => {
    try {
      await props.onOpen(selection);
      props.onClose();
    } catch (caught) {
      log.warn("failed to open showfile selection", caught);
      setError("Could not open showfile.");
    }
  };

  /** Collect the name and initial content before starting a new showfile. */
  const openNewShowfile = async () => {
    const options = await promptForNewShowfile();
    if (!options) return;
    return openSelection({ type: "new", ...options });
  };

  /** Tracks the showfile groups with the newest known saved, draft, or revision update. */
  const mostRecentShowfiles = createMemo(() =>
    mostRecentlyUpdatedShowfileNames(showfiles()),
  );

  return (
    <Show when={props.open}>
      <DialogBackdrop
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <DialogSurface
          role="dialog"
          aria-modal="true"
          aria-label="Open Showfile"
          class="max-w-2xl"
        >
          <DialogHeader>
            <DialogTitle>Open Showfile</DialogTitle>
            <div class="flex items-center gap-2">
              <Button
                type="button"
                aria-label="New showfile"
                onClick={() => void openNewShowfile()}
              >
                <FilePlusIcon class="size-4" aria-hidden />
                <span>New Show</span>
              </Button>
              <DialogCloseButton
                type="button"
                aria-label="Close open showfile dialog"
                onClick={props.onClose}
              />
            </div>
          </DialogHeader>

          <DialogBody class="max-h-[60vh] overflow-y-auto">
            <Show when={isLoading()}>
              <div class="rounded border border-gray-800 bg-gray-950 px-4 py-5 text-sm text-gray-400">
                Loading showfiles...
              </div>
            </Show>

            <Show when={!isLoading() && error()}>
              {(message) => (
                <div class="space-y-3 rounded border border-red-900/60 bg-red-950/30 px-4 py-4">
                  <p class="text-sm text-red-200">{message()}</p>
                  <Button
                    variant="danger"
                    type="button"
                    onClick={() => void loadShowfiles()}
                  >
                    Retry
                  </Button>
                </div>
              )}
            </Show>

            <Show when={!isLoading() && !error() && showfiles().length === 0}>
              <div class="rounded border border-gray-800 bg-gray-950 px-4 py-5 text-sm text-gray-400">
                No showfiles found.
              </div>
            </Show>

            <Show when={!isLoading() && !error() && showfiles().length > 0}>
              <div class="overflow-hidden rounded border border-gray-700">
                <For each={showfiles()}>
                  {(showfile) => (
                    <div class="border-t border-gray-800 first:border-t-0">
                      <div class="flex w-full items-stretch hover:bg-gray-800 focus-within:bg-gray-800">
                        <SearchPickerOption
                          type="button"
                          class="min-w-0 flex-1"
                          aria-label={
                            expandedShowfiles().has(showfile.name)
                              ? `Hide revisions for ${showfile.name}`
                              : `Show revisions for ${showfile.name}`
                          }
                          onClick={() => toggleExpanded(showfile.name)}
                        >
                          <span class="flex w-4 shrink-0 items-center justify-center text-gray-400">
                            <Dynamic
                              component={
                                expandedShowfiles().has(showfile.name)
                                  ? CaretDownIcon
                                  : CaretRightIcon
                              }
                              class="size-4"
                              aria-hidden
                            />
                          </span>
                          <span class="flex min-w-0 flex-1 flex-col gap-1">
                            <span class="flex min-w-0 flex-wrap items-center gap-2">
                              <span class="inline-flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-gray-100">
                                <FolderOpenIcon
                                  class="size-4 shrink-0 text-gray-400"
                                  aria-hidden
                                />
                                <span class="truncate">{showfile.name}</span>
                              </span>
                              <Show
                                when={mostRecentShowfiles().has(showfile.name)}
                              >
                                <span class="shrink-0 rounded border border-sky-700/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-sky-300">
                                  Most recent
                                </span>
                              </Show>
                            </span>
                            <span class="truncate text-xs text-gray-400">
                              {formatModifiedTime(
                                showfileGroupModifiedTimeMs(showfile),
                              )}
                            </span>
                          </span>
                        </SearchPickerOption>
                        <Show when={showfileLoadError(showfile)}>
                          {(loadError) => (
                            <span class="inline-flex shrink-0 items-center py-3 pr-4 pl-2">
                              <ShowfileLoadErrorBadge error={loadError()} />
                            </span>
                          )}
                        </Show>
                      </div>
                      <Show when={expandedShowfiles().has(showfile.name)}>
                        <div class="border-t border-gray-800 bg-gray-950/60 py-1 pl-10">
                          <Show
                            when={
                              hasSavedShowfileRevision(showfile) ||
                              showfile.draft ||
                              (showfile.revisions ?? []).length > 0
                            }
                            fallback={
                              <div class="px-4 py-2 text-sm text-gray-500">
                                No revisions available.
                              </div>
                            }
                          >
                            <Show when={showfile.draft}>
                              {(draft) => (
                                <div class="flex w-full items-center">
                                  <SearchPickerOption
                                    type="button"
                                    class="min-w-0 flex-1"
                                    aria-label={`Load draft for ${showfile.name}`}
                                    disabled={Boolean(
                                      showfileLoadError(draft()),
                                    )}
                                    onClick={() =>
                                      void openSelection({
                                        type: "draft",
                                        showfileName: draftShowfileName(
                                          draft(),
                                          showfile.name,
                                        ),
                                      })
                                    }
                                  >
                                    <div class="flex w-full min-w-0 flex-wrap items-center justify-between gap-1">
                                      <span class="inline-flex shrink-0 items-center gap-2 text-xs text-gray-100">
                                        <span>
                                          {formatModifiedTime(
                                            modifiedTimeMs(draft()),
                                          )}
                                        </span>
                                        <span class="rounded border border-amber-700/70 px-1.5 py-0.5 text-[10px] uppercase text-amber-300">
                                          Draft
                                        </span>
                                      </span>
                                      <span class="min-w-0 basis-48 grow truncate text-right font-mono text-[11px] text-gray-400">
                                        {showfileRevisionPathLabel(
                                          draft().path,
                                          draft().name,
                                        )}
                                      </span>
                                    </div>
                                  </SearchPickerOption>
                                  <Show when={showfileLoadError(draft())}>
                                    {(loadError) => (
                                      <span class="shrink-0 pr-4">
                                        <ShowfileLoadErrorBadge
                                          error={loadError()}
                                        />
                                      </span>
                                    )}
                                  </Show>
                                </div>
                              )}
                            </Show>
                            <Show when={hasSavedShowfileRevision(showfile)}>
                              <div class="flex w-full items-center">
                                <SearchPickerOption
                                  type="button"
                                  class="min-w-0 flex-1"
                                  aria-label={
                                    showfile.draft
                                      ? `Revert to saved showfile ${showfile.name}`
                                      : `Open saved showfile ${showfile.name}`
                                  }
                                  disabled={Boolean(
                                    showfileLoadError(showfile),
                                  )}
                                  onClick={() =>
                                    void openSelection({
                                      type: "showfile",
                                      name: showfile.name,
                                      discardDraft: Boolean(showfile.draft),
                                    })
                                  }
                                >
                                  <div class="flex w-full min-w-0 flex-wrap items-center justify-between gap-1">
                                    <span class="inline-flex shrink-0 items-center gap-2 text-xs text-gray-100">
                                      <span>
                                        {formatModifiedTime(
                                          modifiedTimeMs(showfile),
                                        )}
                                      </span>
                                      <span class="rounded border border-green-700/70 px-1.5 py-0.5 text-[10px] uppercase text-green-300">
                                        Saved
                                      </span>
                                    </span>
                                    <span class="min-w-0 basis-48 grow truncate text-right font-mono text-[11px] text-gray-400">
                                      {savedShowfileRevisionName(showfile)}
                                    </span>
                                  </div>
                                </SearchPickerOption>
                                <Show when={showfileLoadError(showfile)}>
                                  {(loadError) => (
                                    <span class="shrink-0 pr-4">
                                      <ShowfileLoadErrorBadge
                                        error={loadError()}
                                      />
                                    </span>
                                  )}
                                </Show>
                              </div>
                            </Show>
                            <For each={showfile.revisions ?? []}>
                              {(revision) => (
                                <div class="flex w-full items-center">
                                  <SearchPickerOption
                                    type="button"
                                    class="min-w-0 flex-1"
                                    aria-label={`Load backup ${revision.name} for ${showfile.name}`}
                                    disabled={Boolean(
                                      showfileLoadError(revision),
                                    )}
                                    onClick={() =>
                                      void openSelection({
                                        type: "revision",
                                        showfileName: showfile.name,
                                        revisionName: revision.name,
                                      })
                                    }
                                  >
                                    <div class="flex w-full min-w-0 flex-wrap items-center justify-between gap-1">
                                      <span class="shrink-0 text-xs text-gray-100">
                                        {formatModifiedTime(
                                          modifiedTimeMs(revision),
                                        )}
                                      </span>
                                      <span class="min-w-0 basis-48 grow truncate text-right font-mono text-[11px] text-gray-400">
                                        {showfileRevisionPathLabel(
                                          revision.path,
                                          revision.name,
                                        )}
                                      </span>
                                    </div>
                                  </SearchPickerOption>
                                  <Show when={showfileLoadError(revision)}>
                                    {(loadError) => (
                                      <span class="shrink-0 pr-4">
                                        <ShowfileLoadErrorBadge
                                          error={loadError()}
                                        />
                                      </span>
                                    )}
                                  </Show>
                                </div>
                              )}
                            </For>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </DialogBody>
        </DialogSurface>
      </DialogBackdrop>
    </Show>
  );
}
