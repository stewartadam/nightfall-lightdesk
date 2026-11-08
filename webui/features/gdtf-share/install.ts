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
  GdtfShareInstall,
  UnloadableFixtureFile,
} from "../../types";
import { installGdtfShareFixture } from "./fixtures";

/** How long to wait for the library to list an install before giving up on finding it. */
const LIBRARY_WAIT_MS = 8000;

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
function waitForInstalledFile(
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

/**
 * Installs one GDTF Share revision and waits for the fixture library to take it up.
 *
 * Resolves with the file the engine wrote and what the library made of it, or no outcome
 * when the library has not listed it in time. Rejects like {@link installGdtfShareFixture}.
 */
export async function installIntoLibrary(
  fixture: GdtfShareFixture,
  onProgress: (progress: GdtfShareDownloadProgress) => void,
  signal: AbortSignal,
): Promise<{
  installed: GdtfShareInstall;
  outcome: InstalledOutcome | undefined;
}> {
  const installed = await installGdtfShareFixture(fixture, onProgress, signal);
  const outcome = await waitForInstalledFile(installed, signal);
  return { installed, outcome };
}

/**
 * Words a note for an install the library did not list: the file it could not read and
 * why, or that it has not appeared yet.
 */
export function installOutcomeNote(
  installed: GdtfShareInstall,
  outcome: InstalledOutcome | undefined,
): string {
  return outcome?.kind === "unloadable"
    ? `Installed as ${installed.file_name}, but Nightfall can't read it: ${outcome.file.error}`
    : `Installed as ${installed.file_name}, but the library has not listed it yet.`;
}
