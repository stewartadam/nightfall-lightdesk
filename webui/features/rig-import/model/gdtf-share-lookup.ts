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
} from "solid-js";
import { getLogger } from "../../../lib/logger";
import { activeShellDialog } from "../../../state/shell-dialog";
import type * as types from "../../../types";
import {
  GdtfShareRequestError,
  installGdtfShareFixture,
  matchGdtfShare,
  waitForInstalledFile,
} from "../../gdtf-share";
import { missingTypeNames } from "./rig-import-model";

const log = getLogger(import.meta.url);

/** A download from GDTF Share for one missing fixture type. */
export interface GdtfShareDownload {
  /** `GDTFSpec` of the type being downloaded. */
  spec: string;
  /** Bytes received so far, once the download has started. */
  progress?: types.GdtfShareDownloadProgress;
}

/** What the rig import does once a download is in the fixture library. */
export interface GdtfShareLookupHandlers {
  /** Uses the installed library fixture for the type the file names `spec`. */
  onInstalled: (
    spec: string,
    entry: types.AvailableFixtureInfo,
  ) => void | Promise<void>;
  /** Sends the user to sign in to GDTF Share. */
  onSignedOut: () => void;
}

/**
 * Looks the fixture types a rig file leaves out up on GDTF Share, by the manufacturer and
 * fixture names in their specs, and downloads them into the fixture library on request.
 *
 * Lookups follow the preview: a preview with other missing types asks the engine again, and
 * a lookup that fails only logs, since the import works without it. Downloads run one at a
 * time and stop listening when the review is reset or closed.
 */
export function createGdtfShareLookup(
  preview: Accessor<types.RigImportPreview | undefined>,
  handlers: GdtfShareLookupHandlers,
) {
  const [matches, setMatches] = createSignal<
    ReadonlyMap<string, types.GdtfShareFixture>
  >(new Map());
  const [download, setDownload] = createSignal<GdtfShareDownload>();
  const [notes, setNotes] = createSignal<ReadonlyMap<string, string>>(
    new Map(),
  );
  let lifetime = new AbortController();
  onCleanup(() => lifetime.abort());

  /** Sets or clears the note shown under the type `spec`. */
  const setNote = (spec: string, note?: string) => {
    const next = new Map(notes());
    if (note) next.set(spec, note);
    else next.delete(spec);
    setNotes(next);
  };

  const shellDialog = useStore(activeShellDialog);
  /** The missing names as one comparable key, so unrelated preview changes keep it equal. */
  const namesKey = createMemo(() => {
    const current = preview();
    return current ? JSON.stringify(missingTypeNames(current)) : "[]";
  });

  /**
   * Asks the engine which missing types GDTF Share lists whenever the set of missing names
   * changes, so changing an unrelated option does not look the same types up again. Also
   * asks again when Settings closes, since signing in there can fetch the list a lookup
   * without one could not answer from.
   */
  createEffect(
    on(
      [namesKey, () => shellDialog() === "settings"],
      ([key, settingsOpen]) => {
        if (settingsOpen) return;
        const lookups = JSON.parse(key) as ReturnType<typeof missingTypeNames>;
        if (lookups.length === 0) {
          setMatches(new Map());
          return;
        }
        const request = new AbortController();
        onCleanup(() => request.abort());
        matchGdtfShare(
          lookups.map((lookup) => lookup.name),
          request.signal,
        )
          .then((found) => {
            const next = new Map<string, types.GdtfShareFixture>();
            lookups.forEach((lookup, index) => {
              const fixture = found[index];
              if (fixture) next.set(lookup.spec, fixture);
            });
            setMatches(next);
          })
          .catch((failure) => {
            if (request.signal.aborted) return;
            log.debug("GDTF Share lookup failed", failure);
            setMatches(new Map());
          });
      },
    ),
  );

  /**
   * Downloads the GDTF Share match for `spec` into the fixture library and, once the library
   * lists it, hands the entry to `onInstalled` and waits for it, so the type stays busy
   * until the review shows it resolved. Signed out, it sends the user to sign in
   * and notes why nothing was downloaded.
   */
  const downloadType = async (spec: string) => {
    const fixture = matches().get(spec);
    if (!fixture || download()) return;
    const signal = lifetime.signal;
    setNote(spec);
    setDownload({ spec });
    try {
      const installed = await installGdtfShareFixture(
        fixture,
        (progress) => setDownload({ spec, progress }),
        signal,
      );
      const outcome = await waitForInstalledFile(installed, signal);
      if (signal.aborted) return;
      if (outcome?.kind === "listed") {
        await handlers.onInstalled(spec, outcome.entry);
      } else if (outcome?.kind === "unloadable") {
        setNote(
          spec,
          `Downloaded as ${installed.file_name}, but Nightfall can't read it: ${outcome.file.error}`,
        );
      } else {
        setNote(
          spec,
          `Downloaded as ${installed.file_name}, but the library has not listed it yet.`,
        );
      }
    } catch (failure) {
      if (signal.aborted) return;
      if (failure instanceof GdtfShareRequestError && failure.signedOut) {
        setNote(
          spec,
          "Sign in to GDTF Share in Settings, then download again.",
        );
        handlers.onSignedOut();
      } else {
        log.warn("GDTF Share download failed", failure);
        setNote(
          spec,
          failure instanceof Error ? failure.message : String(failure),
        );
      }
    } finally {
      if (!signal.aborted) setDownload(undefined);
    }
  };

  /** Forgets notes and stops listening to a running download, for a new review. */
  const reset = () => {
    lifetime.abort();
    lifetime = new AbortController();
    setDownload(undefined);
    setNotes(new Map());
  };

  return {
    /** The newest GDTF Share revision listed for the missing type `spec`, if any. */
    match: (spec: string) => matches().get(spec),
    /** The download running, if any. */
    download,
    /** The note left by the last download of `spec`, if any. */
    note: (spec: string) => notes().get(spec),
    downloadType,
    reset,
  };
}
