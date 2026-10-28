// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowClockwiseIcon } from "@squidlab/phosphor-solid/arrow-clockwise";
import { CloudArrowDownIcon } from "@squidlab/phosphor-solid/cloud-arrow-down";
import {
  children,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { useAppShell } from "../../components/providers/app-shell";
import { Alert } from "../../components/ui/alert";
import { EmptyState } from "../../components/ui/empty-state";
import { ProgressBar } from "../../components/ui/progress-bar";
import { SearchField } from "../../components/ui/search-field";
import { Button } from "../../components/ui/visual-language/button";
import DataGrid, {
  activeGridSelectionRow,
  createKeyedDataGridCellProvider,
  singleRowGridSelection,
} from "../../components/widgets/data-grid";
import {
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
} from "../../lib/data-grid-types";
import { getLogger } from "../../lib/logger";
import { fixtureLibrary } from "../../state/appStores";
import { activeShellDialog } from "../../state/shell-dialog";
import type {
  AvailableFixtureInfo,
  GdtfShareDownloadProgress,
  GdtfShareFixture,
  GdtfShareSearchResults,
} from "../../types";
import { requestGdtfShareAccount } from "./account";
import {
  installGdtfShareFixture,
  libraryCopiesOf,
  refreshGdtfShare,
  searchGdtfShare,
} from "./fixtures";
import { GdtfShareRequestError } from "./request";

const log = getLogger(import.meta.url);

/** Pause after the last keystroke before searching, so typing sends one request. */
const SEARCH_DELAY_MS = 250;

/** How long to wait for the library to list an install before giving up on finding it. */
const LIBRARY_WAIT_MS = 8000;

const COLUMNS: GridColumn[] = [
  { id: "manufacturer", title: "Make", width: 140, minWidth: 96 },
  { id: "fixture", title: "Model", width: 200, minWidth: 120 },
  { id: "revision", title: "Revision", width: 150, minWidth: 80 },
  { id: "modes", title: "Modes", width: 72, sizing: "fixed", align: "right" },
  { id: "rating", title: "Rating", width: 72, sizing: "fixed", align: "right" },
  { id: "library", title: "Library", width: 96, minWidth: 80 },
];

/** The engine's GDTF Share account as the browser knows it. */
type AccountState =
  | { kind: "loading" }
  | { kind: "signed-in" }
  | { kind: "signed-out" }
  | { kind: "failed"; message: string };

/** Returns a failure's message for display. */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** Projects one GDTF Share result into a cell; `inLibrary` marks fixture types already installed. */
function resultCell(
  fixture: GdtfShareFixture,
  column: GridColumn,
  inLibrary: boolean,
): GridCell {
  /** A left-aligned text cell. */
  const text = (data: string): GridCell => ({
    kind: GridCellKind.Text,
    data,
    contentAlign: "left",
  });
  switch (column.id) {
    case "manufacturer":
      return text(fixture.manufacturer);
    case "fixture":
      return text(fixture.fixture);
    case "revision":
      return text(fixture.revision);
    case "modes":
      return {
        kind: GridCellKind.Number,
        data: fixture.modes.length,
        displayData: String(fixture.modes.length),
        contentAlign: "right",
      };
    case "rating":
      return {
        kind: GridCellKind.Number,
        data: fixture.rating ?? 0,
        displayData: fixture.rating == null ? "–" : fixture.rating.toFixed(1),
        contentAlign: "right",
      };
    default:
      return text(inLibrary ? "In library" : "");
  }
}

/**
 * Resolves with the library entry whose fingerprint is `assetEtag`: at once when the
 * library already lists it, as it does for a download identical to an installed copy, or
 * as soon as the library picks the new file up.
 *
 * Resolves with `undefined` when none appears in time, or when `signal` aborts the wait.
 */
function waitForLibraryEntry(
  assetEtag: string,
  signal: AbortSignal,
): Promise<AvailableFixtureInfo | undefined> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    /** Stops waiting and resolves with `entry`. */
    const finish = (entry?: AvailableFixtureInfo) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      queueMicrotask(() => unsubscribe());
      resolve(entry);
    };
    /** Gives up when the browser that asked goes away. */
    const abort = () => finish();
    const timer = setTimeout(() => finish(), LIBRARY_WAIT_MS);
    signal.addEventListener("abort", abort);
    unsubscribe = fixtureLibrary.subscribe((library) => {
      const entry = library.find(
        (candidate) => candidate.asset_etag === assetEtag,
      );
      if (entry) finish(entry);
    });
  });
}

/** Formats a byte count in whole kilobytes, at least 1, for download progress. */
function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
}

/** Formats a Unix time as a short local date for "list updated" notes. */
function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    dateStyle: "medium",
  });
}

export interface GdtfShareBrowserProps {
  /** Search text, kept by the caller so it survives switching views. */
  query: string;
  /** Receives the search text on every keystroke. */
  onQueryChange: (query: string) => void;
  /** Receives the library entry to use once a fixture is installed or already in the library. */
  onUse: (entry: AvailableFixtureInfo) => void;
  /** Verb on the button that uses a library copy, such as "Use" or "Show". */
  useLabel: string;
  /** Controls placed before the search field on the same row, such as a view switch. */
  leading?: JSX.Element;
}

/**
 * Searches GDTF Share through the engine and installs a chosen fixture into the library.
 *
 * Results come from the engine's saved copy of the GDTF Share list, so typing never waits on
 * GDTF Share once the list is fetched. Results whose fixture type is already in the library
 * say so and offer the library copy. Without a signed-in account it points to Settings, and
 * checks again when Settings closes.
 */
export function GdtfShareBrowser(props: GdtfShareBrowserProps) {
  const { openSettings } = useAppShell();
  const $fixtureLibrary = useStore(fixtureLibrary);
  const $shellDialog = useStore(activeShellDialog);
  const [account, setAccount] = createSignal<AccountState>({ kind: "loading" });
  const [results, setResults] = createSignal<GdtfShareSearchResults>();
  const [searching, setSearching] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [selectedRid, setSelectedRid] = createSignal<number>();
  const [reportedSelection, setReportedSelection] =
    createSignal<GridSelection>();
  const [installing, setInstalling] = createSignal(false);
  const [download, setDownload] = createSignal<GdtfShareDownloadProgress>();
  const [installNote, setInstallNote] = createSignal<string>();
  /** Aborts the search in flight, and everything else once the browser unmounts. */
  let searchAbort: AbortController | undefined;
  const lifetime = new AbortController();
  /** The caller's leading controls, resolved once so checking for them builds nothing extra. */
  const leading = children(() => props.leading);
  onCleanup(() => {
    searchAbort?.abort();
    lifetime.abort();
  });

  /** Reads whether the engine has a GDTF Share account, which searching needs. */
  const loadAccount = async () => {
    try {
      const status = await requestGdtfShareAccount("status");
      if (lifetime.signal.aborted) return;
      setAccount({ kind: status.user ? "signed-in" : "signed-out" });
    } catch (failure) {
      if (lifetime.signal.aborted) return;
      log.warn("Could not read the GDTF Share account", failure);
      setAccount({ kind: "failed", message: messageOf(failure) });
    }
  };

  /**
   * Reads the account on mount and again whenever a shell dialog such as Settings closes,
   * so signing in from the button below takes effect without reopening the browser.
   */
  createEffect(
    on($shellDialog, (dialog) => {
      if (dialog === null) void loadAccount();
    }),
  );

  /** Moves to the signed-out prompt, or shows `failure` above the results. */
  const handleFailure = (failure: unknown, action: string) => {
    if (failure instanceof GdtfShareRequestError && failure.signedOut) {
      setAccount({ kind: "signed-out" });
      return;
    }
    log.warn(`GDTF Share ${action} failed`, failure);
    setError(messageOf(failure));
  };

  /**
   * Fetches every result for `query`; the table draws only the visible rows. A newer
   * search cancels an older one still in flight.
   */
  const runSearch = async (query: string) => {
    searchAbort?.abort();
    const abort = new AbortController();
    searchAbort = abort;
    setSearching(true);
    setError(undefined);
    try {
      setResults(await searchGdtfShare(query, abort.signal));
    } catch (failure) {
      if (!abort.signal.aborted) handleFailure(failure, "search");
    } finally {
      if (searchAbort === abort) setSearching(false);
    }
  };

  /** Searches again shortly after the query changes, once the account is signed in. */
  createEffect(
    on([() => props.query.trim(), () => account().kind], ([query, kind]) => {
      if (kind !== "signed-in") return;
      const timer = setTimeout(() => runSearch(query), SEARCH_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );

  /** Fetches the GDTF Share list again, then repeats the current search on it. */
  const refresh = async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      await refreshGdtfShare();
      await runSearch(props.query.trim());
    } catch (failure) {
      handleFailure(failure, "refresh");
    } finally {
      setRefreshing(false);
    }
  };

  /** Whether a search or refresh is under way. */
  const busy = () => searching() || refreshing();

  /** Whether searching is possible: signed in, or still finding out. */
  const usable = () =>
    account().kind === "signed-in" || account().kind === "loading";

  /** Results on screen, best match first. */
  const fixtures = createMemo(() => results()?.fixtures ?? []);

  /** Fixture type ids that already have a copy in the library. */
  const libraryTypes = createMemo(
    () =>
      new Set(
        $fixtureLibrary()
          .map((entry) => entry.gdtf_fixture_type_id)
          .filter((id): id is string => Boolean(id)),
      ),
  );

  /** The chosen result, looked up by revision id so it stays put across pages. */
  const selected = createMemo(() =>
    fixtures().find((fixture) => fixture.rid === selectedRid()),
  );

  /** Library copies of the selected result's fixture type. */
  const selectedCopies = createMemo(() =>
    libraryCopiesOf(selected()?.fixture_type_id, $fixtureLibrary()),
  );

  /**
   * Keys results by revision id so selection survives paging and header sorts, and rebuilds
   * when the library changes so the Library column stays current.
   */
  const cellProvider = createMemo(() => {
    const installed = libraryTypes();
    return createKeyedDataGridCellProvider({
      rows: fixtures(),
      columns: COLUMNS,
      rowKey: (fixture) => String(fixture.rid),
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) =>
        resultCell(
          row,
          column,
          Boolean(row.fixture_type_id) &&
            installed.has(row.fixture_type_id as string),
        ),
    });
  });

  /** Highlights the selected result wherever it sits in the list. */
  const selection = createMemo(() => {
    const rid = selectedRid();
    return singleRowGridSelection(
      rid === undefined
        ? undefined
        : fixtures().findIndex((fixture) => fixture.rid === rid),
      reportedSelection(),
    );
  });

  /** Clears an earlier install note when another result is chosen. */
  createEffect(on(selectedRid, () => setInstallNote(undefined)));

  /**
   * Installs the selected result, showing the download's progress, then hands the library
   * entry the saved file became to `onUse`. A download identical to a library copy is that
   * copy, so it is handed over at once.
   */
  const install = async () => {
    const fixture = selected();
    if (!fixture) return;
    setInstalling(true);
    setDownload(undefined);
    setInstallNote(undefined);
    try {
      const installed = await installGdtfShareFixture(
        fixture,
        setDownload,
        lifetime.signal,
      );
      const entry = await waitForLibraryEntry(
        installed.asset_etag,
        lifetime.signal,
      );
      if (lifetime.signal.aborted) return;
      if (entry) {
        props.onUse(entry);
      } else {
        setInstallNote(
          `Installed as ${installed.file_name}, but the library has not listed it yet.`,
        );
      }
    } catch (failure) {
      if (lifetime.signal.aborted) return;
      if (failure instanceof GdtfShareRequestError && failure.signedOut) {
        setAccount({ kind: "signed-out" });
      }
      log.warn("GDTF Share install failed", failure);
      setInstallNote(messageOf(failure));
    } finally {
      if (!lifetime.signal.aborted) {
        setInstalling(false);
        setDownload(undefined);
      }
    }
  };

  /** Shown instead of results when the account is missing or could not be read. */
  const accountPrompt = () => {
    const state = account();
    if (state.kind === "failed") {
      return (
        <EmptyState
          icon={CloudArrowDownIcon}
          title="GDTF Share is unavailable"
          description={state.message}
        />
      );
    }
    return (
      <EmptyState
        icon={CloudArrowDownIcon}
        title="Sign in to GDTF Share"
        description="GDTF Share needs a free account. Sign in from Settings on the computer running Nightfall."
        action={
          <Button
            variant="primary"
            onClick={() =>
              openSettings({ tab: "accounts", setting: "gdtf-share-user" })
            }
            data-testid="gdtf-share-open-settings"
          >
            Open Settings
          </Button>
        }
      />
    );
  };

  return (
    <div
      class="flex h-full min-h-0 flex-col gap-3"
      data-testid="gdtf-share-browser"
    >
      <Show when={leading() || usable()}>
        <div class="flex items-center gap-2">
          {leading()}
          <Show when={usable()}>
            <SearchField
              label="Search GDTF Share"
              placeholder="Search GDTF Share by make, model or mode..."
              density="compact"
              value={props.query}
              onInput={props.onQueryChange}
              autofocus
              class="flex-1"
              data-testid="gdtf-share-search"
            />
            <Button
              size="icon-compact"
              variant="subtle"
              aria-label="Refresh the GDTF Share list"
              tooltip="Refresh the GDTF Share list"
              aria-busy={busy()}
              disabled={busy() || account().kind !== "signed-in"}
              onClick={refresh}
              data-testid="gdtf-share-refresh"
            >
              <ArrowClockwiseIcon
                class={`size-4 ${busy() ? "animate-spin motion-reduce:animate-none" : ""}`}
                aria-hidden
              />
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={usable()} fallback={accountPrompt()}>
        <Show when={error()}>
          {(message) => (
            <Alert variant="caution" density="compact">
              {message()}
            </Alert>
          )}
        </Show>
        <section
          aria-label="GDTF Share results"
          class="flex-1 min-h-0 overflow-hidden rounded border border-gray-700 bg-neutral-900"
        >
          <Show
            when={fixtures().length > 0}
            fallback={
              <EmptyState
                loading={busy() || account().kind === "loading"}
                title={
                  busy() || account().kind === "loading"
                    ? "Searching GDTF Share…"
                    : "No GDTF Share fixtures match your search"
                }
                density="compact"
              />
            }
          >
            <DataGrid
              ariaLabel="GDTF Share fixtures"
              readOnly
              selectionMode="row"
              columns={COLUMNS}
              rows={fixtures().length}
              cellProvider={cellProvider}
              freezeColumns={2}
              gridSelection={selection()}
              onGridSelectionChange={(next) => {
                setReportedSelection(next);
                const row = activeGridSelectionRow(next);
                const fixture = row === undefined ? undefined : fixtures()[row];
                if (fixture) setSelectedRid(fixture.rid);
              }}
            />
          </Show>
        </section>
        <div class="text-xs text-gray-500" data-testid="gdtf-share-count">
          <Show when={results()}>
            {(found) => (
              <>
                {found().total === 1
                  ? "1 fixture"
                  : `${found().total.toLocaleString()} fixtures`}
                . List updated {formatDate(found().fetched_at)}.
              </>
            )}
          </Show>
        </div>
        <Show when={selected()}>
          {(fixture) => (
            <div
              class="flex flex-col gap-2 rounded border border-gray-700 bg-neutral-900 p-3 text-sm"
              data-testid="gdtf-share-selected"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="font-medium text-gray-100">
                    {fixture().manufacturer} {fixture().fixture}
                  </div>
                  <div class="text-gray-400">
                    Revision {fixture().revision || "unnamed"}
                    {fixture().manufacturer_upload
                      ? " · Uploaded by the manufacturer"
                      : ""}
                    {" · "}
                    {kilobytes(fixture().file_size)}
                  </div>
                </div>
                <div class="flex shrink-0 gap-2">
                  <Show when={selectedCopies()[0]}>
                    {(copy) => (
                      <Button
                        size="compact"
                        disabled={installing()}
                        onClick={() => props.onUse(copy())}
                        data-testid="gdtf-share-use-copy"
                      >
                        {props.useLabel} library copy
                      </Button>
                    )}
                  </Show>
                  <Button
                    size="compact"
                    variant={
                      selectedCopies().length > 0 ? "secondary" : "primary"
                    }
                    disabled={installing()}
                    onClick={install}
                    data-testid="gdtf-share-install"
                  >
                    {installing()
                      ? "Installing…"
                      : selectedCopies().length > 0
                        ? "Install this revision"
                        : "Install"}
                  </Button>
                </div>
              </div>
              <div class="text-gray-400">
                <For each={fixture().modes}>
                  {(mode, index) => (
                    <>
                      {index() > 0 ? ", " : ""}
                      {mode.name} ({mode.footprint} ch)
                    </>
                  )}
                </For>
              </div>
              <Show when={installing()}>
                <div class="flex items-center gap-2" role="status">
                  <ProgressBar
                    label="GDTF Share download progress"
                    value={download()?.received}
                    max={download()?.total}
                    class="flex-1"
                    data-testid="gdtf-share-download-progress"
                  />
                  <span class="shrink-0 text-xs text-gray-400">
                    {download()
                      ? `${kilobytes(download()?.received ?? 0)} of ${kilobytes(download()?.total ?? 0)}`
                      : "Downloading…"}
                  </span>
                </div>
              </Show>
              <Show when={installNote()}>
                {(message) => (
                  <Alert variant="caution" density="compact">
                    {message()}
                  </Alert>
                )}
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
