// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Alert } from "../../../components/ui/alert";
import {
  Dialog,
  DialogBody,
  DialogCancelButton,
  DialogFooter,
} from "../../../components/ui/dialog";
import { Checkbox, NativeSelect } from "../../../components/ui/form-controls";
import { ProgressBar } from "../../../components/ui/progress-bar";
import { Button } from "../../../components/ui/visual-language/button";
import { hasDiskStorage } from "../../../lib/disk-storage";
import {
  computeFixtureChannelCount,
  fetchRevisionDetails,
  updateFixturesToRevision,
} from "../../../lib/fixture-service";
import { getLogger } from "../../../lib/logger";
import { saveShowfileAndAwait } from "../../../lib/showfile-actions";
import {
  fixtureLibrary,
  fixtures,
  runtimeCapabilities,
} from "../../../state/appStores";
import type {
  AvailableFixtureInfo,
  GdtfShareDownloadProgress,
  GdtfShareUpdate,
  LibraryFixtureModeUpdate,
  LibraryRevisionMode,
} from "../../../types";
import {
  installIntoLibrary,
  installOutcomeNote,
  kilobytes,
} from "../../gdtf-share";
import {
  defaultModeFor,
  type PatchedModeGroup,
  patchedModeGroups,
  revisionChangesSince,
} from "../revision-update";

const log = getLogger(import.meta.url);

export interface RevisionUpdateDialogProps {
  /** The selected library file, which has an update on GDTF Share. */
  from: AvailableFixtureInfo;
  /** The update found for it. */
  update: GdtfShareUpdate;
  /** Closes the dialog without changing the patched fixtures. */
  onDismiss: () => void;
  /** Closes the dialog once the update is in the library and fixtures moved to it. */
  onDone: (entry: AvailableFixtureInfo) => void;
}

/** Names a count of fixtures, such as "1 fixture" or "3 fixtures". */
function fixtureCount(count: number): string {
  return `${count} ${count === 1 ? "fixture" : "fixtures"}`;
}

/** Names a count of DMX channels, such as "1 channel" or "16 channels". */
function channelCount(count: number): string {
  return `${count} ${count === 1 ? "channel" : "channels"}`;
}

/**
 * Updates a library file to its GDTF Share revision in one dialog. With patched fixtures,
 * opening it downloads the update, then shows what changed and which new mode each mode
 * in use becomes, and confirming moves every fixture to it in one undoable engine change,
 * after saving the show when asked. With none patched, confirming only adds the update to
 * the library. Render it only while open, so every opening starts afresh.
 */
export function RevisionUpdateDialog(props: RevisionUpdateDialogProps) {
  const $library = useStore(fixtureLibrary);
  const $fixtures = useStore(fixtures);
  const $capabilities = useStore(runtimeCapabilities);
  const [installed, setInstalled] = createSignal<AvailableFixtureInfo>();
  const [download, setDownload] = createSignal<GdtfShareDownloadProgress>();
  const [downloading, setDownloading] = createSignal(false);
  const [updating, setUpdating] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();
  const [chosen, setChosen] = createSignal<Record<string, string>>({});
  const [saveFirst, setSaveFirst] = createSignal(true);
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());

  /** The update's library entry, once installed or when the library already has it. */
  const target = createMemo(() => {
    const copy = props.update.library_copy;
    return (
      installed() ??
      (copy ? $library().find((entry) => entry.asset_etag === copy) : undefined)
    );
  });

  /**
   * Patched fixtures of this make and model on any revision but the update, grouped by
   * mode. Other old revisions come along, since a mode can't be left on two revisions.
   * Held while the update runs, so the review doesn't empty as fixtures move.
   */
  const groups = createMemo((previous: PatchedModeGroup[] | undefined) =>
    updating() && previous
      ? previous
      : patchedModeGroups(
          Object.values($fixtures()),
          props.from.make,
          props.from.model,
          target()?.asset_etag ?? props.update.library_copy ?? "",
        ),
  );

  /** How many fixtures the update moves. */
  const moving = createMemo(() =>
    groups().reduce((count, group) => count + group.fixtures.length, 0),
  );

  /** The update's modes and notes, read once it is in the library and fixtures move. */
  const [details] = createResource(
    () => (moving() > 0 ? target() : undefined),
    (entry) => fetchRevisionDetails(entry.make, entry.model, entry.asset_etag),
  );

  /**
   * The update's details once they arrive, or nothing while loading or after a failure,
   * since reading a failed resource throws instead of returning nothing.
   */
  const loaded = () => (details.state === "ready" ? details() : undefined);

  /** The update's modes, empty until its details arrive. */
  const modes = createMemo((): LibraryRevisionMode[] => loaded()?.modes ?? []);

  /** Notes the update records since this file's revision. */
  const changes = createMemo(() =>
    revisionChangesSince(
      loaded()?.revision_notes ?? [],
      props.from.gdtf_revision,
    ),
  );

  /** The new mode for fixtures in `mode`: the user's pick, else the default. */
  const choiceFor = (mode: string): string | undefined =>
    chosen()[mode] ?? defaultModeFor(mode, modes());

  /** Returns how many more channels a group's new mode uses, when it grows. */
  const growth = (group: PatchedModeGroup): number => {
    const fixture = modes().find(
      (mode) => mode.name === choiceFor(group.mode),
    )?.fixture;
    if (!fixture) return 0;
    return Math.max(
      0,
      computeFixtureChannelCount(fixture) -
        computeFixtureChannelCount(group.fixtures[0]),
    );
  };

  /** Every fixture with its new mode, or nothing while a mode has no choice. */
  const updates = createMemo((): LibraryFixtureModeUpdate[] | undefined => {
    const result: LibraryFixtureModeUpdate[] = [];
    for (const group of groups()) {
      const mode = choiceFor(group.mode);
      if (!mode) return undefined;
      for (const fixture of group.fixtures) {
        result.push({ id: fixture.identifiers.id, mode });
      }
    }
    return result;
  });

  /** Downloads the update into the library, keeping the entry it becomes. */
  const install = async (): Promise<AvailableFixtureInfo | undefined> => {
    setDownloading(true);
    setFailure(undefined);
    try {
      const { installed: file, outcome } = await installIntoLibrary(
        props.update.latest,
        setDownload,
        lifetime.signal,
      );
      if (lifetime.signal.aborted) return undefined;
      if (outcome?.kind === "listed") {
        setInstalled(outcome.entry);
        return outcome.entry;
      }
      setFailure(installOutcomeNote(file, outcome));
    } catch (error) {
      if (lifetime.signal.aborted) return undefined;
      log.warn("GDTF Share update download failed", error);
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (!lifetime.signal.aborted) setDownloading(false);
    }
    return undefined;
  };

  /** Starts the download at once when fixtures move, so the review can show its details. */
  onMount(() => {
    if (!target() && moving() > 0) void install();
  });

  /** Whether the download failed before fixtures could move, so confirming retries it. */
  const retrying = () => moving() > 0 && !target() && !!failure();

  /** Whether the default action can run now. */
  const ready = () =>
    !downloading() &&
    !updating() &&
    (moving() === 0 || retrying() || !!updates()?.length);

  /**
   * Adds the update to the library when nothing moves, or shows it when it already is
   * there; retries a failed download; otherwise saves the show when asked and moves every
   * fixture to the update in one engine change.
   */
  const confirm = async () => {
    if (!ready()) return;
    if (moving() === 0) {
      const entry = target() ?? (await install());
      if (entry) props.onDone(entry);
      return;
    }
    if (retrying()) {
      await install();
      return;
    }
    const entry = target();
    const planned = updates();
    if (!entry || !planned) return;
    setUpdating(true);
    setFailure(undefined);
    try {
      if (saveFirst() && hasDiskStorage($capabilities())) {
        await saveShowfileAndAwait();
      }
      await updateFixturesToRevision(
        entry.make,
        entry.model,
        entry.asset_etag,
        planned,
      );
      if (!lifetime.signal.aborted) props.onDone(entry);
    } catch (error) {
      if (lifetime.signal.aborted) return;
      log.warn("Revision update failed", error);
      setFailure(error instanceof Error ? error.message : String(error));
      setUpdating(false);
    }
  };

  return (
    <Dialog
      kind="task"
      isOpen
      title={`Update ${props.from.model}`}
      subtitle={`${props.update.installed?.revision || "This file"} → ${props.update.latest.revision || "newest revision"}`}
      onDismiss={props.onDismiss}
      onSubmit={confirm}
      busy={updating()}
      class="max-w-lg"
    >
      <DialogBody class="space-y-4 text-sm">
        <Show when={downloading()}>
          <div class="flex items-center gap-2" role="status">
            <ProgressBar
              label="GDTF Share download progress"
              value={download()?.received}
              max={download()?.total}
              class="flex-1"
            />
            <span class="shrink-0 text-neutral-400 text-xs">
              {download()
                ? `${kilobytes(download()?.received ?? 0)} of ${kilobytes(download()?.total ?? 0)}`
                : "Downloading…"}
            </span>
          </div>
        </Show>
        <Show when={moving() === 0}>
          <p>
            Adds the update to the library next to this file. No patched
            fixtures use this file.
          </p>
        </Show>
        <Show when={moving() > 0 && loaded()}>
          <section class="space-y-1" data-testid="revision-update-changes">
            <h3 class="font-medium">
              {changes().sinceInstalled ? "What changed" : "Latest change"}
            </h3>
            <Show
              when={changes().notes.length > 0}
              fallback={
                <p class="text-neutral-400">The update has no notes.</p>
              }
            >
              <ul class="list-disc space-y-0.5 pl-4">
                <For each={changes().notes}>
                  {(note) => <li>{note.text}</li>}
                </For>
              </ul>
            </Show>
          </section>
          <section class="space-y-2" data-testid="revision-update-modes">
            <h3 class="font-medium">Move {fixtureCount(moving())} to</h3>
            <For each={groups()}>
              {(group) => (
                <div class="space-y-1">
                  <div class="flex items-center gap-2">
                    <span class="min-w-0 flex-1 truncate">
                      {group.mode}{" "}
                      <span class="text-neutral-400">
                        · {fixtureCount(group.fixtures.length)}
                      </span>
                    </span>
                    <NativeSelect
                      density="compact"
                      class="min-w-0 flex-1"
                      aria-label={`New mode for fixtures in ${group.mode}`}
                      value={choiceFor(group.mode) ?? ""}
                      onChange={(event) =>
                        setChosen({
                          ...chosen(),
                          [group.mode]: event.currentTarget.value,
                        })
                      }
                      data-testid="revision-update-mode"
                    >
                      <For each={modes()}>
                        {(mode) => (
                          <option value={mode.name} disabled={!mode.fixture}>
                            {mode.name}
                          </option>
                        )}
                      </For>
                    </NativeSelect>
                  </div>
                  <Show when={growth(group) > 0}>
                    <p class="text-amber-300 text-xs">
                      Uses {channelCount(growth(group))} more and may overlap
                      the next patched fixtures.
                    </p>
                  </Show>
                  <Show when={!choiceFor(group.mode)}>
                    <p class="text-amber-300 text-xs">
                      None of the update's modes can be loaded.
                    </p>
                  </Show>
                </div>
              )}
            </For>
          </section>
        </Show>
        <Show when={details.error}>
          <Alert variant="caution" density="compact" class="break-words">
            {String(details.error)}
          </Alert>
        </Show>
        <Show when={failure()}>
          {(message) => (
            <Alert variant="caution" density="compact" class="break-words">
              {message()}
            </Alert>
          )}
        </Show>
      </DialogBody>
      <DialogFooter>
        <Show when={moving() > 0 && hasDiskStorage($capabilities())}>
          <label class="mr-auto flex items-center gap-2 text-sm">
            <Checkbox
              checked={saveFirst()}
              disabled={updating()}
              onChange={(event) => setSaveFirst(event.currentTarget.checked)}
              data-testid="revision-update-save-first"
            />
            Save the show first
          </label>
        </Show>
        <DialogCancelButton />
        <Button
          variant="primary"
          disabled={!ready()}
          onClick={confirm}
          data-testid="revision-update-confirm"
        >
          {moving() === 0
            ? downloading()
              ? "Adding…"
              : target()
                ? "Show update"
                : "Add to library"
            : updating()
              ? "Updating…"
              : retrying()
                ? "Retry download"
                : `Update ${fixtureCount(moving())}`}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
