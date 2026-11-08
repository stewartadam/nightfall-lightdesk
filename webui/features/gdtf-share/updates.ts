// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";
import { getLogger } from "../../lib/logger";
import { fixtureLibrary } from "../../state/appStores";
import { activeShellDialog } from "../../state/shell-dialog";
import type {
  AvailableFixtureInfo,
  GdtfShareLibraryFixture,
  GdtfShareUpdate,
  GdtfShareUpdates,
} from "../../types";
import { requestGdtfShare } from "./request";

const log = getLogger(import.meta.url);

/** Path of the update check on the backend. */
const UPDATES_PATH = "/api/gdtf-share/updates";

/** Pause after the library last changes before checking, so a rescan sends one request. */
const CHECK_DELAY_MS = 500;

/** Describes the library's GDTF files that name a fixture type, as the update check takes them. */
function checkedFixtures(
  library: readonly AvailableFixtureInfo[],
): GdtfShareLibraryFixture[] {
  return library.flatMap((entry) =>
    entry.gdtf_fixture_type_id
      ? [
          {
            asset_etag: entry.asset_etag,
            fixture_type_id: entry.gdtf_fixture_type_id,
            revision: entry.gdtf_revision,
          },
        ]
      : [],
  );
}

/**
 * Asks the engine which of the library GDTF files `fixtures` have a newer revision on GDTF
 * Share. The engine decides which revision each file is and which is newer; without a
 * signed-in account it lists none.
 */
function requestUpdates(
  fixtures: GdtfShareLibraryFixture[],
  signal?: AbortSignal,
): Promise<GdtfShareUpdates> {
  return requestGdtfShare(UPDATES_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fixtures }),
    signal,
  });
}

/**
 * Tracks newer GDTF Share revisions of the fixture library's files, keyed by file
 * fingerprint, while `enabled` holds.
 *
 * Checks again shortly after the library changes, and whenever a shell dialog such as
 * Settings closes, so signing in shows updates without reopening the panel. A failed check
 * keeps the last answer and is logged.
 */
export function createGdtfShareUpdates(
  enabled: Accessor<boolean>,
): Accessor<ReadonlyMap<string, GdtfShareUpdate>> {
  const $fixtureLibrary = useStore(fixtureLibrary);
  const $shellDialog = useStore(activeShellDialog);
  const [updates, setUpdates] = createSignal<
    ReadonlyMap<string, GdtfShareUpdate>
  >(new Map());

  /**
   * The library files the check sends. Rebuilt from each entry's fields, since the library
   * store is reconciled in place and its array alone does not change when files come and go.
   */
  const checked = createMemo(() => checkedFixtures($fixtureLibrary()));

  /** Identifies the checked files, so a check runs only when the set of files changes. */
  const checkedKey = createMemo(() =>
    checked()
      .map((fixture) => fixture.asset_etag)
      .join("\n"),
  );

  /** Checks the library once enabled, again after its files or the open dialog change, cancelling a check still in flight. */
  createEffect(
    on(
      [enabled, checkedKey, () => $shellDialog() === null],
      ([active, , noDialog]) => {
        if (!active) {
          setUpdates(new Map());
          return;
        }
        if (!noDialog) return;
        const fixtures = untrack(checked);
        if (fixtures.length === 0) {
          setUpdates(new Map());
          return;
        }
        const abort = new AbortController();
        const timer = setTimeout(async () => {
          try {
            const found = await requestUpdates(fixtures, abort.signal);
            setUpdates(
              new Map(
                found.updates.map((update) => [update.asset_etag, update]),
              ),
            );
          } catch (failure) {
            if (!abort.signal.aborted) {
              log.warn("Could not check GDTF Share for updates", failure);
            }
          }
        }, CHECK_DELAY_MS);
        onCleanup(() => {
          clearTimeout(timer);
          abort.abort();
        });
      },
    ),
  );

  return updates;
}
