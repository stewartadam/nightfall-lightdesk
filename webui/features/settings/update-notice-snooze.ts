// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { persistentJSON } from "@nanostores/persistent";

/** How long Later keeps the update notices for one version away. */
export const UPDATE_NOTICE_SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * Which update notice Later was picked on: the offer of a version to download, or the update
 * that is ready to install. Each is put off on its own, so downloading a snoozed offer from
 * About still announces the update once it is ready.
 */
export type UpdateNoticeKind = "offer" | "ready";

/** The version whose update notice the operator put off, and until when. */
export interface UpdateNoticeSnooze {
  version: string;
  /** Milliseconds since the Unix epoch when the notices may show again. */
  until: number;
}

/**
 * The operator's last Later on each kind of notice, kept on this computer so a restart does not
 * bring the notice back early. A newer version is announced at once, since only the snoozed
 * version is held back.
 */
export const updateNoticeSnoozes = persistentJSON<
  Partial<Record<UpdateNoticeKind, UpdateNoticeSnooze>>
>("nightfall-update-notice-snoozes", {});

/** Builds the snooze Later records for `version`, starting at `now`. */
export function snoozeUpdateNotice(
  version: string,
  now: number,
): UpdateNoticeSnooze {
  return { version, until: now + UPDATE_NOTICE_SNOOZE_MS };
}

/**
 * Returns how many milliseconds the `kind` notice for `version` stays hidden after `now`, or 0
 * when it may show. Storage that does not hold a snooze is ignored, and a snooze that ends
 * implausibly far ahead, as after the clock was set back, is capped at one snooze period.
 */
export function updateNoticeSnoozeRemaining(
  snoozes: unknown,
  kind: UpdateNoticeKind,
  version: string,
  now: number,
): number {
  if (typeof snoozes !== "object" || snoozes === null) return 0;
  const snooze: unknown = (snoozes as Record<string, unknown>)[kind];
  if (
    typeof snooze !== "object" ||
    snooze === null ||
    (snooze as UpdateNoticeSnooze).version !== version
  ) {
    return 0;
  }
  const until = (snooze as UpdateNoticeSnooze).until;
  if (typeof until !== "number" || !Number.isFinite(until)) return 0;
  return Math.min(Math.max(until - now, 0), UPDATE_NOTICE_SNOOZE_MS);
}
