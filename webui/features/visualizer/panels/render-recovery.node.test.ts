// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  HEALTHY_RENDER_MS,
  initialRenderMode,
  planRenderRecovery,
} from "./render-recovery";

/** A renderer's first failure restarts it in the same mode. */
test("planRenderRecovery restarts a renderer that failed for the first time", () => {
  assert.deepEqual(
    planRenderRecovery(
      { mode: "worker", restarted: false, mountedAt: 0, kind: "render-error" },
      10,
    ),
    { action: "restart", mode: "worker" },
  );
  assert.deepEqual(
    planRenderRecovery(
      {
        mode: "main-thread",
        restarted: false,
        mountedAt: 0,
        kind: "render-error",
      },
      10,
    ),
    { action: "restart", mode: "main-thread" },
  );
});

/** A restarted worker renderer that fails again moves to the main thread. */
test("planRenderRecovery falls back from a restarted worker renderer", () => {
  assert.deepEqual(
    planRenderRecovery(
      { mode: "worker", restarted: true, mountedAt: 0, kind: "render-error" },
      10,
    ),
    { action: "fallback", mode: "main-thread" },
  );
});

/** A restarted main-thread renderer that fails again has nowhere left to go. */
test("planRenderRecovery gives up after the main-thread restart fails", () => {
  assert.deepEqual(
    planRenderRecovery(
      {
        mode: "main-thread",
        restarted: true,
        mountedAt: 0,
        kind: "render-error",
      },
      10,
    ),
    { action: "give-up" },
  );
});

/** A restart that rendered healthily for a while earns another restart. */
test("planRenderRecovery restarts again after a healthy stretch", () => {
  assert.deepEqual(
    planRenderRecovery(
      {
        mode: "main-thread",
        restarted: true,
        mountedAt: 0,
        kind: "render-error",
      },
      HEALTHY_RENDER_MS,
    ),
    { action: "restart", mode: "main-thread" },
  );
});

/** Setup failures repeat on every attempt, so they are never restarted. */
test("planRenderRecovery does not restart a renderer that failed to initialize", () => {
  assert.deepEqual(
    planRenderRecovery(
      { mode: "worker", restarted: false, mountedAt: 0, kind: "init-error" },
      10,
    ),
    { action: "fallback", mode: "main-thread" },
  );
  assert.deepEqual(
    planRenderRecovery(
      {
        mode: "main-thread",
        restarted: false,
        mountedAt: 0,
        kind: "init-error",
      },
      10,
    ),
    { action: "give-up" },
  );
});

/** New visualizers skip the worker once worker rendering failed this session. */
test("initialRenderMode honors the setting and earlier worker failures", () => {
  assert.equal(initialRenderMode(true, false), "worker");
  assert.equal(initialRenderMode(true, true), "main-thread");
  assert.equal(initialRenderMode(false, false), "main-thread");
});
