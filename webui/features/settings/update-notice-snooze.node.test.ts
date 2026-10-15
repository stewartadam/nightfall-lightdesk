// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  snoozeUpdateNotice,
  UPDATE_NOTICE_SNOOZE_MS,
  updateNoticeSnoozeRemaining,
} from "./update-notice-snooze";

/** Later hides the snoozed version's notice for a day, then lets it show again. */
test("a snooze hides its version for a day", () => {
  const snoozes = { ready: snoozeUpdateNotice("1.2.0", 1_000) };
  /** Milliseconds the ready notice for 1.2.0 stays hidden at `now`. */
  const remaining = (now: number) =>
    updateNoticeSnoozeRemaining(snoozes, "ready", "1.2.0", now);
  assert.equal(remaining(1_000), UPDATE_NOTICE_SNOOZE_MS);
  assert.equal(remaining(1_000 + UPDATE_NOTICE_SNOOZE_MS - 1), 1);
  assert.equal(remaining(1_000 + UPDATE_NOTICE_SNOOZE_MS), 0);
});

/** A newer version, or the other kind of notice, is announced at once. */
test("a snooze leaves other versions and notices alone", () => {
  const snoozes = { offer: snoozeUpdateNotice("1.2.0", 1_000) };
  assert.equal(
    updateNoticeSnoozeRemaining(snoozes, "offer", "1.3.0", 1_000),
    0,
  );
  assert.equal(
    updateNoticeSnoozeRemaining(snoozes, "ready", "1.2.0", 1_000),
    0,
  );
});

/** Storage that holds no usable snooze never hides a notice. */
test("unusable storage is ignored", () => {
  for (const stored of [
    null,
    "1.2.0",
    { ready: null },
    { ready: { version: "1.2.0" } },
    { ready: { version: "1.2.0", until: "soon" } },
  ]) {
    assert.equal(
      updateNoticeSnoozeRemaining(stored, "ready", "1.2.0", 1_000),
      0,
    );
  }
});

/** A clock set back after Later cannot stretch the snooze past one day. */
test("a snooze never lasts longer than a day", () => {
  const snoozes = {
    ready: snoozeUpdateNotice("1.2.0", 10 * UPDATE_NOTICE_SNOOZE_MS),
  };
  assert.equal(
    updateNoticeSnoozeRemaining(snoozes, "ready", "1.2.0", 0),
    UPDATE_NOTICE_SNOOZE_MS,
  );
});
