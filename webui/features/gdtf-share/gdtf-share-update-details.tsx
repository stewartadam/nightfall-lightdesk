// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { Alert } from "../../components/ui/alert";
import { ProgressBar } from "../../components/ui/progress-bar";
import { Button } from "../../components/ui/visual-language/button";
import { getLogger } from "../../lib/logger";
import { fixtureLibrary } from "../../state/appStores";
import type {
  AvailableFixtureInfo,
  GdtfShareDownloadProgress,
  GdtfShareFixture,
  GdtfShareUpdate,
} from "../../types";
import { gdtfSharePageUrl } from "./fixtures";
import { formatDate, kilobytes } from "./format";
import { installIntoLibrary, installOutcomeNote } from "./install";

const log = getLogger(import.meta.url);

/** Names a GDTF Share revision with who uploaded it and when GDTF Share last changed it. */
function describeRevision(fixture: GdtfShareFixture): string {
  const uploader = fixture.manufacturer_upload ? "manufacturer" : "user";
  return `${fixture.revision || "Unnamed revision"} · ${uploader} upload · ${formatDate(fixture.last_modified)}`;
}

export interface GdtfShareUpdateDetailsProps {
  /** The newer revision found for the selected library file. */
  update: GdtfShareUpdate;
  /** Shows a library entry, once the update is installed or already in the library. */
  onShow: (entry: AvailableFixtureInfo) => void;
}

/**
 * Tells the user a newer GDTF Share revision of the selected library file exists, and
 * installs it next to the current file, or shows the library copy when one already is that
 * revision. The current file stays, so patched fixtures keep using it until changed.
 */
export function GdtfShareUpdateDetails(props: GdtfShareUpdateDetailsProps) {
  const $fixtureLibrary = useStore(fixtureLibrary);
  const [installing, setInstalling] = createSignal(false);
  const [download, setDownload] = createSignal<GdtfShareDownloadProgress>();
  const [note, setNote] = createSignal<string>();
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());

  /** Clears an earlier install note when the update shown changes. */
  createEffect(
    on(
      () => props.update.latest.rid,
      () => setNote(undefined),
    ),
  );

  /** The library entry the engine reports already is the newest revision, if any. */
  const libraryCopy = createMemo(() => {
    const etag = props.update.library_copy;
    return etag
      ? $fixtureLibrary().find((entry) => entry.asset_etag === etag)
      : undefined;
  });

  /** Installs the newest revision and shows the library entry it becomes. */
  const install = async () => {
    setInstalling(true);
    setDownload(undefined);
    setNote(undefined);
    try {
      const { installed, outcome } = await installIntoLibrary(
        props.update.latest,
        setDownload,
        lifetime.signal,
      );
      if (lifetime.signal.aborted) return;
      if (outcome?.kind === "listed") {
        props.onShow(outcome.entry);
      } else {
        setNote(installOutcomeNote(installed, outcome));
      }
    } catch (failure) {
      if (lifetime.signal.aborted) return;
      log.warn("GDTF Share update install failed", failure);
      setNote(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!lifetime.signal.aborted) {
        setInstalling(false);
        setDownload(undefined);
      }
    }
  };

  return (
    <div class="space-y-2 text-sm" data-testid="gdtf-share-update">
      <h3 class="font-medium">Update on GDTF Share</h3>
      <div>
        <span class="text-neutral-400">Newest:</span>{" "}
        {describeRevision(props.update.latest)}
      </div>
      <div>
        <a
          class="text-blue-300 underline"
          href={gdtfSharePageUrl(props.update.latest)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="gdtf-share-update-link"
        >
          See what changed on GDTF Share
        </a>
      </div>
      <div>
        <span class="text-neutral-400">This file:</span>{" "}
        {props.update.installed
          ? describeRevision(props.update.installed)
          : "a revision GDTF Share has since replaced"}
      </div>
      <Show
        when={libraryCopy()}
        fallback={
          <>
            <Button
              size="compact"
              variant="primary"
              disabled={installing()}
              onClick={install}
              data-testid="gdtf-share-install-update"
            >
              {installing() ? "Installing…" : "Install update"}
            </Button>
            <p class="text-neutral-400 text-xs">
              The update is added next to this file. Patched fixtures keep using
              this file until you change their fixture type.
            </p>
          </>
        }
      >
        {(copy) => (
          <Button
            size="compact"
            onClick={() => props.onShow(copy())}
            data-testid="gdtf-share-show-update"
          >
            Show library copy
          </Button>
        )}
      </Show>
      <Show when={installing()}>
        <div class="flex items-center gap-2" role="status">
          <ProgressBar
            label="GDTF Share download progress"
            value={download()?.received}
            max={download()?.total}
            class="flex-1"
          />
          <span class="shrink-0 text-xs text-neutral-400">
            {download()
              ? `${kilobytes(download()?.received ?? 0)} of ${kilobytes(download()?.total ?? 0)}`
              : "Downloading…"}
          </span>
        </div>
      </Show>
      <Show when={note()}>
        {(message) => (
          <Alert variant="caution" density="compact" class="break-words">
            {message()}
          </Alert>
        )}
      </Show>
    </div>
  );
}
