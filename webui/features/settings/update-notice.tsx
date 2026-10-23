// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
  $desktopUpdate,
  downloadDesktopUpdate,
  openDownloadsPage,
  restartToUpdate,
  startDesktopUpdates,
} from "../../lib/desktop-updates";
import { getLogger } from "../../lib/logger";
import { pushToast } from "../../state/notifications";
import {
  snoozeUpdateNotice,
  type UpdateNoticeKind,
  updateNoticeSnoozeRemaining,
  updateNoticeSnoozes,
} from "./update-notice-snooze";

const log = getLogger(import.meta.url);

/**
 * Tells the operator, in the desktop app only, when a newer version waits to be downloaded
 * because automatic downloads are off, when it can only be downloaded from the downloads page
 * because this build cannot install updates, and when a downloaded update is ready. The update never
 * installs while the app runs, so a running show is never interrupted: it waits until the
 * operator picks Restart, here or in About, or until the app quits when automatic installs are
 * on. After the restart it says whether the update installed. Later puts off that notice for that version for a day, even across restarts; About still
 * offers the update meanwhile.
 */
export function UpdateNotice() {
  const update = useStore($desktopUpdate);
  /** Version and install choice the notice was last shown for, so each is announced once. */
  let announced: string | null = null;
  let closeNotice: (() => void) | undefined;

  onMount(() => void startDesktopUpdates());

  const snoozes = useStore(updateNoticeSnoozes);
  /** Changes when a snooze runs out while the app is open, so the notices are shown again. */
  const [snoozeEnded, setSnoozeEnded] = createSignal(0);
  let snoozeTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(snoozeTimer));

  /**
   * Returns whether Later still holds back the `kind` notice for `version`, and arranges for the
   * notices to be reconsidered the moment the snooze ends.
   */
  const snoozed = (kind: UpdateNoticeKind, version: string): boolean => {
    snoozeEnded();
    const remaining = updateNoticeSnoozeRemaining(
      snoozes(),
      kind,
      version,
      Date.now(),
    );
    clearTimeout(snoozeTimer);
    if (remaining === 0) return false;
    snoozeTimer = setTimeout(
      () => setSnoozeEnded((count) => count + 1),
      remaining,
    );
    return true;
  };

  /** Puts off the `kind` notice for `version` for a day, and lets it show again once it ends. */
  const later = (kind: UpdateNoticeKind, version: string) => {
    updateNoticeSnoozes.set({
      ...updateNoticeSnoozes.get(),
      [kind]: snoozeUpdateNotice(version, Date.now()),
    });
    if (kind === "offer") offered = null;
    else announced = null;
  };

  /** Version the download offer was last shown for, so each version is offered once. */
  let offered: string | null = null;
  let closeOffer: (() => void) | undefined;

  /**
   * Offers a newer version found while automatic downloads are off, or that this build cannot
   * install itself, and withdraws the offer once a download starts.
   */
  createEffect(() => {
    const current = update();
    const version = current?.version;
    // With automatic downloads on, a found version starts downloading at once, so it is only
    // offered here after its automatic download failed.
    const waiting =
      current?.phase === "available" &&
      (!current.canInstall ||
        current.updateMode === "notify" ||
        current.error?.kind === "download");
    if (!waiting || !version || snoozed("offer", version)) {
      closeOffer?.();
      closeOffer = undefined;
      return;
    }
    if (offered === version) return;
    offered = version;
    if (!current.canInstall) {
      closeOffer = pushToast(
        "info",
        `Nightfall ${current.version} is available from nightfall.live/downloads.`,
        0,
        [
          { label: "Go to Downloads", onClick: openDownloadsPage },
          { label: "Later", onClick: () => later("offer", version) },
        ],
        { title: "Update available" },
      );
      return;
    }
    const downloadFailed = current.error?.kind === "download";
    closeOffer = pushToast(
      downloadFailed ? "warning" : "info",
      downloadFailed
        ? `Couldn't download Nightfall ${current.version}. Try again now, or later from About.`
        : `Nightfall ${current.version} is available. Download it now, or later from About.`,
      0,
      [
        {
          label: downloadFailed ? "Try again" : "Download",
          onClick: () => {
            downloadDesktopUpdate().catch((error) =>
              log.error("Could not download the update", { error }),
            );
          },
        },
        { label: "Later", onClick: () => later("offer", version) },
      ],
      { title: downloadFailed ? "Update download failed" : "Update available" },
    );
  });

  /** Shows the notice when an update becomes ready, and withdraws it once it is installing. */
  createEffect(() => {
    const current = update();
    if (current?.phase !== "ready" || !current.version) {
      if (current?.phase === "installing") {
        closeNotice?.();
        closeNotice = undefined;
      }
      return;
    }
    if (snoozed("ready", current.version)) {
      closeNotice?.();
      closeNotice = undefined;
      return;
    }
    const version = current.version;
    const installFailed = current.error?.kind === "install";
    // Switching installs on quit on or off changes what the notice promises, and a failed install
    // changes it again, so either shows the notice again.
    const key = `${current.version}:${current.updateMode === "install"}:${installFailed}`;
    if (announced === key) return;
    announced = key;
    closeNotice?.();
    let message: string;
    if (installFailed) {
      message = `Nightfall ${current.version} couldn't be installed, so you're still on this version. Try again now, or later from About.`;
    } else if (current.updateMode === "install") {
      message = `Nightfall ${current.version} will install the next time you quit. Restart now to install it sooner; your work is saved first.`;
    } else {
      message = `Nightfall ${current.version} is ready to install. Your work is saved before the app restarts.`;
    }
    closeNotice = pushToast(
      installFailed ? "warning" : "info",
      message,
      0,
      [
        {
          label: installFailed ? "Try again" : "Restart to update",
          onClick: () => {
            restartToUpdate().catch((error) =>
              log.error("Could not restart to install the update", { error }),
            );
          },
        },
        { label: "Later", onClick: () => later("ready", version) },
      ],
      { title: installFailed ? "Update couldn't install" : "Update ready" },
    );
  });

  /** Version this launch was updated to and already announced, so it is announced once. */
  let welcomed: string | null = null;

  /** Says, once on the first launch after an update, which version is now running, until closed. */
  createEffect(() => {
    const updatedTo = update()?.updatedTo;
    if (!updatedTo || welcomed === updatedTo) return;
    welcomed = updatedTo;
    pushToast(
      "success",
      `You're now running Nightfall ${updatedTo}.`,
      // Startup often has the operator looking elsewhere, so the notice stays until closed.
      0,
      [],
      {
        title: "Nightfall updated",
      },
    );
  });

  return null;
}
