// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  appLifecycle,
  beginAppLifecycleStartup,
  normalizeRestoredAppLifecycleState,
  restartAppLifecycleForBackendSessionReset,
  transitionAppLifecycle,
} from "./app-lifecycle";

/** Restores the lifecycle store to its fresh page-load state. */
function resetLifecycleStore(): void {
  appLifecycle.set({
    phase: "runtime-initializing",
    draftRecovery: null,
    recoveryError: null,
    startupDraftRecoveryEnabled: false,
    startupDraftRecoveryChecked: false,
  });
}

afterEach(() => {
  resetLifecycleStore();
});

test("beginAppLifecycleStartup initializes draft recovery on a fresh page load", () => {
  resetLifecycleStore();

  beginAppLifecycleStartup(true);

  assert.deepEqual(appLifecycle.get(), {
    phase: "backend-connecting",
    draftRecovery: null,
    recoveryError: null,
    startupDraftRecoveryEnabled: true,
    startupDraftRecoveryChecked: false,
  });
});

test("beginAppLifecycleStartup does not restart startup after the app is interactive", () => {
  resetLifecycleStore();
  beginAppLifecycleStartup(true);
  transitionAppLifecycle({ type: "interactive" });

  beginAppLifecycleStartup(true);

  assert.equal(appLifecycle.get().phase, "interactive");
  assert.equal(appLifecycle.get().startupDraftRecoveryChecked, true);
});

test("beginAppLifecycleStartup preserves an active draft prompt across remounts", () => {
  resetLifecycleStore();
  beginAppLifecycleStartup(true);
  transitionAppLifecycle({
    type: "draft-prompt",
    draftRecovery: {
      showfileName: "default",
      modifiedMs: 1_700_000_100_000,
      savedModifiedMs: 1_700_000_000_000,
      hasDraft: true,
      hasSavedSnapshot: true,
    },
  });

  beginAppLifecycleStartup(true);

  assert.equal(appLifecycle.get().phase, "startup-draft-prompt");
  assert.equal(appLifecycle.get().draftRecovery?.showfileName, "default");
});

test("showfile-prompt transition waits for user selection", () => {
  resetLifecycleStore();
  beginAppLifecycleStartup(true);

  transitionAppLifecycle({ type: "showfile-prompt" });

  assert.equal(appLifecycle.get().phase, "startup-showfile-prompt");
  assert.equal(appLifecycle.get().startupDraftRecoveryChecked, true);
});

test("restartAppLifecycleForBackendSessionReset returns interactive sessions to startup", () => {
  resetLifecycleStore();
  beginAppLifecycleStartup(true);
  transitionAppLifecycle({ type: "interactive" });

  restartAppLifecycleForBackendSessionReset();

  assert.deepEqual(appLifecycle.get(), {
    phase: "backend-connecting",
    draftRecovery: null,
    recoveryError: null,
    startupDraftRecoveryEnabled: true,
    startupDraftRecoveryChecked: false,
  });
});

test("normalizeRestoredAppLifecycleState makes loading phases restartable", () => {
  const restored = normalizeRestoredAppLifecycleState({
    phase: "startup-loading-saved",
    draftRecovery: null,
    recoveryError: null,
    startupDraftRecoveryEnabled: true,
    startupDraftRecoveryChecked: true,
  });

  assert.deepEqual(restored, {
    phase: "backend-connecting",
    draftRecovery: null,
    recoveryError: null,
    startupDraftRecoveryEnabled: true,
    startupDraftRecoveryChecked: false,
  });
});
