// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { getLogger } from "../../lib/logger";

interface Notice {
  name: string;
  version: string;
  license: string;
  source: string;
  text: string;
}

interface NoticesDocument {
  schemaVersion: number;
  distribution: string;
  entries: Notice[];
}

const log = getLogger(import.meta.url);

/** Load the same notice inventory that accompanies this distribution's binaries. */
async function fetchNotices(): Promise<NoticesDocument> {
  const response = await fetch(
    `${import.meta.env.BASE_URL}notices/THIRD-PARTY-NOTICES.json`,
  );
  if (!response.ok)
    throw new Error(`Could not load third-party notices (${response.status})`);
  const document = await response.json();
  if (document.schemaVersion !== 1 || !Array.isArray(document.entries))
    throw new Error("Invalid third-party notices file");
  return document;
}

/** Present searchable component attributions while keeping long license texts collapsed. */
export default function ThirdPartyNotices(props: { active: boolean }) {
  const [query, setQuery] = createSignal("");
  const [document, { refetch }] = createResource(
    () => props.active,
    fetchNotices,
  );
  /** Keep recoverable loading failures inside the dialog instead of the app error boundary. */
  const loaded = createMemo(() => (document.error ? undefined : document()));
  /** Match package names, licenses, source URLs, and copyright holders. */
  const entries = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    return (loaded()?.entries ?? []).filter((entry) =>
      `${entry.name} ${entry.license} ${entry.source} ${entry.text}`
        .toLocaleLowerCase()
        .includes(needle),
    );
  });

  /** Retry a failed resource request and record the failure through the app logger. */
  function retry() {
    log.warn("Retrying third-party notice loading", { error: document.error });
    void refetch();
  }

  return (
    <div class="space-y-3">
      <Show when={document.loading}>
        <p role="status">Loading third-party notices…</p>
      </Show>
      <Show when={document.error}>
        <p role="alert">Third-party notices could not be loaded.</p>
        <button type="button" class="text-blue-300 underline" onClick={retry}>
          Retry
        </button>
      </Show>
      <Show when={loaded()}>
        <p class="text-sm text-gray-400">{loaded()?.distribution}</p>
        <label class="block text-sm text-gray-300">
          Search licenses and attributions
          <input
            type="search"
            class="mt-1 w-full rounded border border-gray-600 bg-gray-950 px-3 py-2 text-gray-100"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Package, license, or copyright holder"
          />
        </label>
        <p class="text-xs text-gray-400" role="status">
          {entries().length}{" "}
          {entries().length === 1 ? "component" : "components"}
        </p>
        <For each={entries()}>
          {(entry) => (
            <details class="rounded border border-gray-700 bg-black/20 p-3">
              <summary class="cursor-pointer break-words text-sm text-gray-200">
                <span class="font-semibold">{entry.name}</span> {entry.version}
                <span class="ml-2 text-gray-400">{entry.license}</span>
              </summary>
              <p class="my-3 break-all text-xs text-gray-400">
                Source:{" "}
                <a
                  class="text-blue-300 underline"
                  href={entry.source
                    .replace(/^git\+/, "")
                    .replace(/^git:/, "https:")}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {entry.source}
                </a>
              </p>
              <pre class="whitespace-pre-wrap break-words text-xs leading-5 text-gray-300">
                {entry.text}
              </pre>
            </details>
          )}
        </For>
      </Show>
    </div>
  );
}
