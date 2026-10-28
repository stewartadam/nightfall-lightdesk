// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  AvailableFixtureInfo,
  GdtfShareDownloadProgress,
  GdtfShareFixture,
  GdtfShareInstall,
  GdtfShareInstallEvent,
  GdtfShareSearchResults,
} from "../../types";
import {
  GDTF_SHARE_SIGNED_OUT_STATUS,
  GdtfShareRequestError,
  requestGdtfShare,
  sendGdtfShare,
} from "./request";

/** Path of the fixture search on the backend. */
const FIXTURES_PATH = "/api/gdtf-share/fixtures";

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
 * that is the cause, and a reply that ends without an outcome rejects too.
 */
export async function installGdtfShareFixture(
  fixture: GdtfShareFixture,
  onProgress: (progress: GdtfShareDownloadProgress) => void,
): Promise<GdtfShareInstall> {
  const response = await sendGdtfShare(
    `${FIXTURES_PATH}/${fixture.rid}/install`,
    { method: "POST" },
  );
  const lines = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
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
