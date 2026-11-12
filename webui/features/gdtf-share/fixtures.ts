// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { fixtureLibrary, unloadableFixtureFiles } from "../../state/appStores";
import type {
  AvailableFixtureInfo,
  GdtfShareDownloadProgress,
  GdtfShareFixture,
  GdtfShareFixtureName,
  GdtfShareInstall,
  GdtfShareInstallEvent,
  GdtfShareMatches,
  GdtfShareSearchResults,
  UnloadableFixtureFile,
} from "../../types";
import {
  GDTF_SHARE_SIGNED_OUT_STATUS,
  GdtfShareRequestError,
  requestGdtfShare,
  sendGdtfShare,
} from "./request";

/** Path of the fixture search on the backend. */
const FIXTURES_PATH = "/api/gdtf-share/fixtures";

/** How long to wait for the library to list an install before giving up on finding it. */
const LIBRARY_WAIT_MS = 8000;

/**
 * Looks fixture types up on GDTF Share by manufacturer and fixture name, resolving with the
 * newest revision listed under each name, or `null`, in the order of `names`. The engine
 * answers from its saved list even while signed out, and with no saved list every answer
 * is `null`.
 */
export async function matchGdtfShare(
  names: readonly GdtfShareFixtureName[],
  signal?: AbortSignal,
): Promise<(GdtfShareFixture | null)[]> {
  const reply = await requestGdtfShare<GdtfShareMatches>(
    `${FIXTURES_PATH}/match`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures: names }),
      signal,
    },
  );
  return reply.matches.map((match) => match.fixture ?? null);
}

/**
 * Searches the engine's saved GDTF Share list for every fixture matching every word of
 * `query`, best match first. The first search after signing in waits for the engine to
 * fetch the list.
 */
export function searchGdtfShare(
  query: string,
  signal?: AbortSignal,
): Promise<GdtfShareSearchResults> {
  const params = new URLSearchParams({ query });
  return requestGdtfShare(`${FIXTURES_PATH}?${params}`, { signal });
}

/** Asks the engine to fetch the GDTF Share list again now. */
export function refreshGdtfShare(): Promise<GdtfShareSearchResults> {
  return requestGdtfShare(`${FIXTURES_PATH}/refresh`, { method: "POST" });
}

/**
 * Downloads one GDTF Share revision into the engine's fixture library folder, resolving
 * with the file it wrote and the fixture type id the archive declares.
 *
 * The engine streams one JSON event per line; `onProgress` hears each progress line.
 * A failure line rejects with a {@link GdtfShareRequestError}, marked signed out when
 * that is the cause, and a reply that ends without an outcome rejects too. `signal` stops
 * listening, with the browser's `AbortError`; the engine still finishes the install.
 */
export async function installGdtfShareFixture(
  fixture: GdtfShareFixture,
  onProgress: (progress: GdtfShareDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<GdtfShareInstall> {
  const response = await sendGdtfShare(
    `${FIXTURES_PATH}/${fixture.rid}/install`,
    { method: "POST", signal },
  );
  const lines = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  try {
    while (lines) {
      const { done, value } = await lines.read();
      if (value) buffered += value;
      const complete = buffered.split("\n");
      buffered = done ? "" : (complete.pop() ?? "");
      for (const line of complete) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as GdtfShareInstallEvent;
        switch (event.type) {
          case "Progress":
            onProgress(event.data);
            break;
          case "Installed":
            return event.data;
          case "Failed":
            throw new GdtfShareRequestError(
              event.data.message,
              event.data.signed_out ? GDTF_SHARE_SIGNED_OUT_STATUS : 500,
            );
        }
      }
      if (done) break;
    }
  } finally {
    void lines?.cancel().catch(() => {});
  }
  throw new GdtfShareRequestError(
    "Nightfall stopped answering before the install finished.",
    0,
  );
}

/**
 * Returns the library entries of GDTF fixture type `typeId`, matched by the
 * `FixtureTypeID` both the library and GDTF Share report. No id matches nothing.
 */
export function libraryCopiesOf(
  typeId: string | null | undefined,
  library: readonly AvailableFixtureInfo[],
): AvailableFixtureInfo[] {
  if (!typeId) return [];
  return library.filter((entry) => entry.gdtf_fixture_type_id === typeId);
}

/** What the library made of an installed file: a listed entry, or a file it could not load. */
export type InstalledOutcome =
  | { kind: "listed"; entry: AvailableFixtureInfo }
  | { kind: "unloadable"; file: UnloadableFixtureFile };

/**
 * Waits for the library to take up an installed file. Resolves with the entry whose
 * fingerprint is `installed.asset_etag` at once when the library already lists it, as it does
 * for a download identical to an installed copy, or as soon as the library picks the new file
 * up. A listing that reports `installed.file_name` as unloadable resolves with that failure
 * instead; only listings that arrive while waiting count, since an earlier one may describe a
 * file the download replaced, though the latest listing is checked once more on timeout.
 *
 * Resolves with `undefined` when none appears in time, or when `signal` aborts the wait.
 */
export function waitForInstalledFile(
  installed: GdtfShareInstall,
  signal: AbortSignal,
): Promise<InstalledOutcome | undefined> {
  /** Finds the failure the library reports for the installed file, if any. */
  const unloadable = (): InstalledOutcome | undefined => {
    const file = unloadableFixtureFiles
      .get()
      .find(
        (candidate) =>
          !candidate.in_showfile && candidate.file_name === installed.file_name,
      );
    return file && { kind: "unloadable", file };
  };
  return new Promise((resolve) => {
    const unsubscribers: (() => void)[] = [];
    /** Stops waiting and resolves with `outcome`. */
    const finish = (outcome?: InstalledOutcome) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      queueMicrotask(() => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      });
      resolve(outcome);
    };
    /** Gives up when the caller that asked goes away. */
    const abort = () => finish();
    const timer = setTimeout(() => finish(unloadable()), LIBRARY_WAIT_MS);
    signal.addEventListener("abort", abort);
    unsubscribers.push(
      fixtureLibrary.subscribe((library) => {
        const entry = library.find(
          (candidate) => candidate.asset_etag === installed.asset_etag,
        );
        if (entry) finish({ kind: "listed", entry });
      }),
      unloadableFixtureFiles.listen(() => {
        const failure = unloadable();
        if (failure) finish(failure);
      }),
    );
  });
}
