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
  Show,
} from "solid-js";
import { Alert } from "../../../components/ui/alert";
import { Checkbox, NativeSelect } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { hasDiskStorage } from "../../../lib/disk-storage";
import {
  computeFixtureChannelCount,
  fetchRevisionDetails,
  updateFixturesToRevision,
} from "../../../lib/fixture-service";
import { getLogger } from "../../../lib/logger";
import { saveShowfileAndAwait } from "../../../lib/showfile-actions";
import { fixtures, runtimeCapabilities } from "../../../state/appStores";
import type {
  AvailableFixtureInfo,
  LibraryFixtureModeUpdate,
  LibraryRevisionMode,
} from "../../../types";
import {
  defaultModeFor,
  type PatchedModeGroup,
  patchedModeGroups,
  revisionChangesSince,
} from "../revision-update";

const log = getLogger(import.meta.url);

export interface RevisionUpdateReviewProps {
  /** Library revision the patched fixtures use now. */
  from: AvailableFixtureInfo;
  /** Library revision to move them to. */
  to: AvailableFixtureInfo;
  /** Called with a summary once the fixtures are updated. */
  onUpdated: (summary: string) => void;
  /** Called when the user closes the review without updating. */
  onCancel: () => void;
}

/** Formats a channel count, such as "1 channel" or "16 channels". */
function channels(count: number): string {
  return `${count} channel${count === 1 ? "" : "s"}`;
}

/**
 * Reviews moving every patched fixture of one library revision to another before doing
 * it: what changed according to the new file, which new mode each current mode becomes and
 * how its channel count changes, and an offer to save the show first. The update itself is
 * one engine change that a single undo puts back.
 */
export function RevisionUpdateReview(props: RevisionUpdateReviewProps) {
  const $fixtures = useStore(fixtures);
  const $capabilities = useStore(runtimeCapabilities);
  const [details] = createResource(
    () => props.to,
    (to) => fetchRevisionDetails(to.make, to.model, to.asset_etag),
  );
  const [chosen, setChosen] = createSignal<Record<string, string>>({});
  const [saveFirst, setSaveFirst] = createSignal(true);
  const [updating, setUpdating] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();
  let closed = false;
  onCleanup(() => {
    closed = true;
  });

  /**
   * Patched fixtures of this make and model on any other revision, grouped by the mode
   * they use. Fixtures of other old revisions come along, since a mode can't be left on
   * two revisions.
   */
  const groups = createMemo(() =>
    patchedModeGroups(
      Object.values($fixtures()),
      props.from.make,
      props.from.model,
      props.to.asset_etag,
    ),
  );

  /** How many fixtures the update moves. */
  const fixtureCount = createMemo(() =>
    groups().reduce((count, group) => count + group.fixtures.length, 0),
  );

  /** How many of them come from revisions other than the selected file. */
  const fromOtherRevisions = createMemo(() =>
    groups().reduce(
      (count, group) =>
        count +
        group.fixtures.filter(
          (fixture) => fixture.library_asset_etag !== props.from.asset_etag,
        ).length,
      0,
    ),
  );

  /** The new revision's modes, empty until the details arrive. */
  const modes = createMemo((): LibraryRevisionMode[] => details()?.modes ?? []);

  /** The new mode for fixtures in `mode`: the user's pick, else the default. */
  const choiceFor = (mode: string): string | undefined =>
    chosen()[mode] ?? defaultModeFor(mode, modes());

  /** What changed since the current file's revision, per the new file's notes. */
  const changes = createMemo(() =>
    revisionChangesSince(
      details()?.revision_notes ?? [],
      props.from.gdtf_revision,
    ),
  );

  /** Returns the new mode's channel count for one group, when it converts. */
  const newChannelCount = (group: PatchedModeGroup): number | undefined => {
    const fixture = modes().find(
      (mode) => mode.name === choiceFor(group.mode),
    )?.fixture;
    return fixture ? computeFixtureChannelCount(fixture) : undefined;
  };

  /** Every fixture with the new mode chosen for its current mode. */
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

  /** Saves the show when asked, then moves every fixture in one undoable change. */
  const update = async () => {
    const planned = updates();
    if (!planned?.length) return;
    setUpdating(true);
    setFailure(undefined);
    try {
      if (saveFirst() && hasDiskStorage($capabilities())) {
        await saveShowfileAndAwait();
      }
      await updateFixturesToRevision(
        props.to.make,
        props.to.model,
        props.to.asset_etag,
        planned,
      );
      if (closed) return;
      const noun = planned.length === 1 ? "fixture" : "fixtures";
      props.onUpdated(
        `Updated ${planned.length} ${noun}. Undo puts them back on the previous revision.`,
      );
    } catch (error) {
      if (closed) return;
      log.warn("Revision update failed", error);
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (!closed) setUpdating(false);
    }
  };

  return (
    <div
      class="space-y-3 rounded border border-neutral-700 p-2"
      data-testid="revision-update-review"
    >
      <h4 class="font-medium">
        Update {fixtureCount()} patched{" "}
        {fixtureCount() === 1 ? "fixture" : "fixtures"}
      </h4>
      <p class="text-neutral-400 text-xs">
        Each fixture keeps its number, name, position and DMX address. Values
        for parameters the new revision drops are no longer used.
      </p>
      <Show when={fromOtherRevisions() > 0}>
        <p class="text-neutral-400 text-xs">
          Includes {fromOtherRevisions()} patched from other revisions of this
          fixture, since a show holds one revision of each mode.
        </p>
      </Show>
      <Show
        when={!details.loading}
        fallback={<p class="text-neutral-400">Reading the new revision…</p>}
      >
        <Show
          when={!details.error}
          fallback={
            <Alert variant="caution" density="compact">
              {String(details.error)}
            </Alert>
          }
        >
          <section class="space-y-1" data-testid="revision-update-changes">
            <h5 class="text-neutral-400 text-xs uppercase">What changed</h5>
            <Show
              when={changes().notes.length > 0}
              fallback={
                <p class="text-neutral-400">
                  The new file has no notes about this change.
                </p>
              }
            >
              <Show when={!changes().sinceInstalled}>
                <p class="text-neutral-400 text-xs">
                  Earlier notes may also apply; the new file doesn't list this
                  file's revision.
                </p>
              </Show>
              <ul class="list-disc space-y-0.5 pl-4">
                <For each={changes().notes}>
                  {(note) => (
                    <li>
                      {note.text}{" "}
                      <span class="text-neutral-400 text-xs">
                        {note.date.slice(0, 10)}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
          <section class="space-y-2" data-testid="revision-update-modes">
            <h5 class="text-neutral-400 text-xs uppercase">Modes</h5>
            <For each={groups()}>
              {(group) => {
                const oldChannels = computeFixtureChannelCount(
                  group.fixtures[0],
                );
                return (
                  <div class="space-y-1">
                    <div class="flex items-center gap-2">
                      <span class="min-w-0 flex-1 truncate">
                        {group.mode}{" "}
                        <span class="text-neutral-400 text-xs">
                          ({group.fixtures.length} × {channels(oldChannels)})
                        </span>
                      </span>
                      <span aria-hidden="true">→</span>
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
                              {mode.fixture
                                ? ` (${channels(computeFixtureChannelCount(mode.fixture))})`
                                : " (can't be loaded)"}
                            </option>
                          )}
                        </For>
                      </NativeSelect>
                    </div>
                    <Show when={!choiceFor(group.mode)}>
                      <Alert variant="caution" density="compact">
                        None of the new revision's modes can be loaded, so these
                        fixtures can't be updated.
                      </Alert>
                    </Show>
                    <Show
                      when={(() => {
                        const count = newChannelCount(group);
                        return count !== undefined && count > oldChannels;
                      })()}
                    >
                      <Alert variant="caution" density="compact">
                        This mode uses{" "}
                        {channels((newChannelCount(group) ?? 0) - oldChannels)}{" "}
                        more, so these fixtures may overlap ones patched right
                        after them.
                      </Alert>
                    </Show>
                  </div>
                );
              }}
            </For>
          </section>
          <Show when={hasDiskStorage($capabilities())}>
            <label class="flex items-center gap-2">
              <Checkbox
                checked={saveFirst()}
                onChange={(event) => setSaveFirst(event.currentTarget.checked)}
                data-testid="revision-update-save-first"
              />
              Save the show first, so Revert to saved can also undo this
            </label>
          </Show>
          <div class="flex gap-2">
            <Button
              size="compact"
              variant="primary"
              disabled={updating() || !updates()?.length}
              onClick={update}
              data-testid="revision-update-confirm"
            >
              {updating()
                ? "Updating…"
                : `Update ${fixtureCount()} ${fixtureCount() === 1 ? "fixture" : "fixtures"}`}
            </Button>
            <Button
              size="compact"
              disabled={updating()}
              onClick={() => props.onCancel()}
            >
              Cancel
            </Button>
          </div>
          <Show when={failure()}>
            {(message) => (
              <Alert variant="caution" density="compact" class="break-words">
                {message()}
              </Alert>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  );
}
