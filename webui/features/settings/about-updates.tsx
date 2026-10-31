// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowClockwiseIcon } from "@squidlab/phosphor-solid/arrow-clockwise";
import { type Accessor, createMemo, createSignal, For, Show } from "solid-js";
import { Alert } from "../../components/ui/alert";
import { NativeSelect } from "../../components/ui/form-controls";
import { ProgressBar } from "../../components/ui/progress-bar";
import { SettingsRow } from "../../components/ui/settings-row";
import { Button } from "../../components/ui/visual-language/button";
import {
  $desktopUpdate,
  checkForDesktopUpdates,
  type DesktopUpdateError,
  type DesktopUpdateMode,
  type DesktopUpdatePhase,
  type DesktopUpdateState,
  downloadDesktopUpdate,
  openDownloadsPage,
  restartToUpdate,
  setDesktopUpdateMode,
} from "../../lib/desktop-updates";

/** Update status and actions shared by the About dialog's update controls. */
export interface AboutUpdates {
  /** Update status of the desktop app, or `undefined` in browsers and on other devices. */
  update: Accessor<DesktopUpdateState | undefined>;
  /** Why the last action the operator took here failed, cleared by the next one. */
  actionError: Accessor<UpdateFailure | undefined>;
  /** Runs one update action, keeping `failure` and the underlying error if it fails. */
  run: (action: () => Promise<void>, failure: string) => void;
}

/** A failed update step: a plain sentence, and the underlying error for troubleshooting. */
interface UpdateFailure {
  message: string;
  details: string;
}

/**
 * Follows the desktop update status for the About dialog. Only the desktop app exposes a status,
 * so browsers and other devices show nothing.
 */
export function createAboutUpdates(): AboutUpdates {
  const status = useStore($desktopUpdate);
  const [actionError, setActionError] = createSignal<UpdateFailure>();
  return {
    update: () => status() ?? undefined,
    actionError,
    run: (action, failure) => {
      setActionError(undefined);
      action().catch((error) =>
        setActionError({ message: failure, details: String(error) }),
      );
    },
  };
}

/** Formats a byte count in megabytes with one decimal, as download sizes are shown. */
function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Headline for the check row in every state, so the row keeps its height as the status changes.
 * The update alert below names the found version and its next step.
 */
function describeCheckHeadline(update: DesktopUpdateState): string {
  if (!update.checkForUpdates) return "Update checks are off";
  switch (update.phase) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return "An update is available";
    case "downloading":
      return "An update is available";
    case "ready":
      return "An update is available";
    case "installing":
      return "An update is available";
  }
  // After a failed check, "up to date" may no longer be true.
  if (update.error?.kind === "check") return "Couldn't check for updates";
  if (update.lastCheckedAt === null) return "Updates haven't been checked yet";
  return "Nightfall is up to date";
}

/** Says when the update service was last reached, or how to turn checks back on. */
function describeLastCheck(update: DesktopUpdateState): string {
  if (!update.checkForUpdates) return "Turn them on in Settings > Privacy.";
  if (update.lastCheckedAt === null) return "Last checked: Never";
  return `Last checked ${new Date(update.lastCheckedAt * 1000).toLocaleString(
    undefined,
    { dateStyle: "medium", timeStyle: "short" },
  )}`;
}

/**
 * Plain-language summary of a check or preferences step the desktop shell reports as failed. A
 * failed download or install is explained by the update alert, next to its Try Again button.
 */
function describeError(
  error: DesktopUpdateError | null,
): UpdateFailure | undefined {
  if (!error || error.kind === "download" || error.kind === "install") {
    return undefined;
  }
  const message = {
    check: "Couldn't reach the update service. Nightfall will try again later.",
    preferences: "Couldn't save your update settings.",
  }[error.kind];
  return { message, details: error.details };
}

/**
 * Shows a failed update step as a plain sentence, with the underlying error beneath it in small
 * selectable text so it can be copied into a support request.
 */
function UpdateErrorMessage(props: { failure: UpdateFailure }) {
  return (
    <Alert
      variant="caution"
      density="compact"
      role="alert"
      data-testid="update-error"
    >
      <p>{props.failure.message}</p>
      <p
        class="mt-1 select-text break-words font-mono text-xs text-gray-400"
        data-testid="update-error-details"
      >
        {props.failure.details}
      </p>
    </Alert>
  );
}

/** Choices for what happens when a check finds a newer version, in the order offered. */
const UPDATE_MODE_OPTIONS: { value: DesktopUpdateMode; label: string }[] = [
  { value: "notify", label: "Notify me" },
  { value: "download", label: "Download, install when I choose" },
  { value: "install", label: "Download and install on quit" },
];

/** Phases in which the desktop shell accepts a check: nothing is checking, downloading or installing. */
const CHECKABLE_PHASES: ReadonlySet<DesktopUpdatePhase> = new Set([
  "idle",
  "available",
  "ready",
]);

/**
 * Shows a headline for the update status and when updates were last checked, beside Check for
 * Updates. The button stays in place in every state, so an operator holding a downloaded
 * update can still look for a newer one; it is disabled while update checks are off in Settings
 * > Privacy, and while a check, download or install is under way.
 */
function CheckRow(props: {
  update: DesktopUpdateState;
  updates: AboutUpdates;
}) {
  return (
    <div class="flex items-center justify-between gap-4">
      <div
        class="flex min-w-0 flex-col gap-0.5"
        role="status"
        data-testid="update-status"
      >
        <p class="text-sm font-medium text-gray-300">
          {describeCheckHeadline(props.update)}
        </p>
        <p class="text-xs text-gray-400">{describeLastCheck(props.update)}</p>
      </div>
      <Button
        size="compact"
        type="button"
        class="shrink-0 items-center gap-2"
        disabled={
          !props.update.checkForUpdates ||
          !CHECKABLE_PHASES.has(props.update.phase)
        }
        onClick={() =>
          props.updates.run(
            checkForDesktopUpdates,
            "Couldn't check for updates.",
          )
        }
      >
        <ArrowClockwiseIcon class="size-4" aria-hidden />
        <span>Check for Updates</span>
      </Button>
    </div>
  );
}

/** Phases in which a found version is shown in the update alert. */
const ALERT_PHASES: ReadonlySet<DesktopUpdatePhase> = new Set([
  "available",
  "downloading",
  "ready",
  "installing",
]);

/** Download progress as a compact bar with the bytes received, for the update alert's action. */
function DownloadProgressMeter(props: { update: DesktopUpdateState }) {
  const downloaded = () => props.update.progress?.downloadedBytes ?? 0;
  const total = () => props.update.progress?.totalBytes ?? null;
  return (
    <div class="flex w-36 flex-col items-end gap-1">
      <ProgressBar
        label="Update download progress"
        value={downloaded()}
        max={total()}
      />
      <span class="text-xs text-gray-400">
        {total() === null
          ? megabytes(downloaded())
          : `${megabytes(downloaded())} of ${megabytes(total() ?? 0)}`}
      </span>
    </div>
  );
}

/**
 * Announces a found version and offers the next step on the right: Download (or Try Again after
 * a failed download, or Go to Downloads for builds that cannot install), download progress, or
 * Restart to update. `phase` is the last settled phase, so the alert and its action stay put
 * while a check runs, with the action disabled until it finishes.
 */
function UpdateAlert(props: {
  update: DesktopUpdateState;
  phase: DesktopUpdatePhase;
  updates: AboutUpdates;
}) {
  const version = () => props.update.version ?? "";
  const checking = () => props.update.phase === "checking";
  const downloadFailed = () => props.update.error?.kind === "download";
  const installFailed = () => props.update.error?.kind === "install";
  /** One-line headline for the found version in its current phase. */
  const title = () => {
    switch (props.phase) {
      case "downloading":
        return `Downloading Nightfall ${version()}`;
      case "ready":
        return installFailed()
          ? `Couldn't install Nightfall ${version()}`
          : `Nightfall ${version()} is ready to install`;
      case "installing":
        return `Restarting to install Nightfall ${version()}…`;
      default:
        return `Nightfall ${version()} is available`;
    }
  };
  /** Supporting line beneath the headline, when the phase has more to say. */
  const detail = () => {
    switch (props.phase) {
      case "available":
        if (!props.update.canInstall) {
          return "Download it from nightfall.live/downloads.";
        }
        return downloadFailed()
          ? "Couldn't download the update. Try again."
          : undefined;
      case "ready":
        if (installFailed()) {
          return "Nightfall kept this version. Try again.";
        }
        return props.update.updateMode === "install"
          ? "Update applied when you next quit Nightfall."
          : "Your work will be saved.";
      default:
        return undefined;
    }
  };
  return (
    <Alert
      variant={
        (props.phase === "available" && downloadFailed()) ||
        (props.phase === "ready" && installFailed())
          ? "warning"
          : "note"
      }
      density="compact"
      align="center"
      data-testid="update-alert"
    >
      <div class="flex w-full items-center justify-between gap-4">
        <div class="flex min-w-0 flex-col gap-0.5">
          <p class="font-medium">{title()}</p>
          <Show when={detail()}>
            {(text) => <p class="text-xs text-gray-400">{text()}</p>}
          </Show>
          <Show
            when={
              (props.phase === "available" && downloadFailed()) ||
              (props.phase === "ready" && installFailed())
            }
          >
            <p
              class="select-text break-words font-mono text-xs text-gray-400"
              data-testid="update-error-details"
            >
              {props.update.error?.details}
            </p>
          </Show>
        </div>
        <div class="shrink-0">
          <Show when={props.phase === "available"}>
            <Show
              when={props.update.canInstall}
              fallback={
                <Button
                  size="compact"
                  type="button"
                  class="whitespace-nowrap"
                  onClick={openDownloadsPage}
                >
                  Go to Downloads
                </Button>
              }
            >
              <Button
                size="compact"
                type="button"
                disabled={checking()}
                onClick={() =>
                  props.updates.run(
                    downloadDesktopUpdate,
                    "Couldn't download the update.",
                  )
                }
              >
                {downloadFailed() ? "Try Again" : "Download"}
              </Button>
            </Show>
          </Show>
          <Show when={props.phase === "downloading"}>
            <DownloadProgressMeter update={props.update} />
          </Show>
          <Show when={props.phase === "ready"}>
            <Button
              size="compact"
              type="button"
              class="whitespace-nowrap"
              disabled={checking()}
              onClick={() =>
                props.updates.run(
                  restartToUpdate,
                  "Couldn't restart to install the update.",
                )
              }
            >
              {installFailed() ? "Try Again" : "Restart to update"}
            </Button>
          </Show>
        </div>
      </div>
    </Alert>
  );
}

/**
 * Shows when updates were last checked beside Check for Updates, an alert for any found version
 * with its next step, and the choice of what happens when a newer version is found.
 */
export function AboutUpdateStatus(props: { updates: AboutUpdates }) {
  /**
   * The last phase other than checking. A check can run while a version waits to download or
   * install, and the alert keeps showing that version, and where it stands, until the check ends.
   */
  const settledPhase = createMemo<DesktopUpdatePhase>((previous) => {
    const phase = props.updates.update()?.phase ?? "idle";
    return phase === "checking" ? previous : phase;
  }, "idle");
  return (
    <Show when={props.updates.update()}>
      {(update) => (
        <section
          aria-label="Updates"
          class="space-y-3 rounded-lg border border-gray-700 bg-gray-900/40 p-4"
        >
          <CheckRow update={update()} updates={props.updates} />
          <Show when={ALERT_PHASES.has(settledPhase()) && update().version}>
            <UpdateAlert
              update={update()}
              phase={settledPhase()}
              updates={props.updates}
            />
          </Show>
          <Show
            when={props.updates.actionError() ?? describeError(update().error)}
          >
            {(failure) => <UpdateErrorMessage failure={failure()} />}
          </Show>
          <Show
            when={update().canInstall}
            fallback={
              <p class="text-xs text-gray-400">
                This build of Nightfall can't install updates itself. When a
                newer version is available, download it from
                nightfall.live/downloads.
              </p>
            }
          >
            <SettingsRow
              class="border-t border-gray-700/70"
              label="When an update is available"
              description="Updates never install while Nightfall is running."
            >
              {(field) => (
                <NativeSelect
                  id={field.id}
                  value={update().updateMode}
                  aria-describedby={field.describedBy}
                  onChange={(event) => {
                    const select = event.currentTarget;
                    const mode = select.value as DesktopUpdateMode;
                    props.updates.run(
                      () =>
                        setDesktopUpdateMode(mode).catch((error) => {
                          // The store keeps the old mode, so Solid won't write it back to the DOM.
                          select.value = update().updateMode;
                          throw error;
                        }),
                      "Couldn't save your update settings.",
                    );
                  }}
                >
                  <For each={UPDATE_MODE_OPTIONS}>
                    {(option) => (
                      <option value={option.value}>{option.label}</option>
                    )}
                  </For>
                </NativeSelect>
              )}
            </SettingsRow>
          </Show>
          <Show when={update().checkForUpdates}>
            <p class="text-xs text-gray-400">
              To stop checking for updates entirely, turn off Allow update
              checks in Settings &gt; Privacy.
            </p>
          </Show>
        </section>
      )}
    </Show>
  );
}
