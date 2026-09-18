// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { findRetiredLifecycleUses } from "./check-command-architecture.mjs";

/** Verifies current semantic lifecycle constructs pass the architecture guard. */
test("semantic command architecture passes", () => {
  const violations = findRetiredLifecycleUses([
    {
      path: "crates/example/src/lib.rs",
      source:
        "MessageReader<CommandEnvelope<FooCommand>> EngineActionEnvelope<FooAction>",
    },
  ]);

  assert.deepEqual(violations, []);
});

/** Verifies every explicitly retired lifecycle identifier is rejected. */
test("retired command architecture identifiers fail", () => {
  const violations = findRetiredLifecycleUses([
    {
      path: "crates/example/src/lib.rs",
      source:
        "CommandStatus CommandResultCandidate Correlated BatchIdTracker PayloadRouter batch_id ActionPayload",
    },
  ]);

  assert.deepEqual(
    violations.map(({ name }) => name),
    [
      "CommandStatus",
      "CommandResultCandidate",
      "Correlated<T>",
      "BatchIdTracker",
      "PayloadRouter",
      "batch_id",
      "ActionPayload",
    ],
  );
});

/** Verifies concrete domain actions cannot return to the transport-neutral engine crate. */
test("engine-owned domain actions fail", () => {
  const violations = findRetiredLifecycleUses([
    {
      path: "crates/engine/src/domain_actions.rs",
      source: "pub enum PlaybackAction { ReleaseAll }",
    },
  ]);

  assert.deepEqual(
    violations.map(({ name }) => name),
    ["engine-owned PlaybackAction"],
  );
});

/** Verifies timeline production code cannot identify desk actions by stable ID. */
test("timeline-owned desk action switches fail", () => {
  const violations = findRetiredLifecycleUses([
    {
      path: "crates/timeline/src/planner.rs",
      source:
        "CLIP_START_ACTION_ID clip_target_for_action desk_eval_command_for_action",
    },
  ]);

  assert.deepEqual(
    violations.map(({ name }) => name),
    [
      "timeline-owned desk action ID",
      "timeline-owned desk action decoder",
      "timeline-owned desk eval decoder",
    ],
  );
});

/** Verifies handlers cannot bypass CommandResponder with a direct result writer. */
test("direct command result writers fail", () => {
  const violations = findRetiredLifecycleUses([
    {
      path: "crates/example/src/lib.rs",
      source: "MessageWriter<\n    CommandResult\n>",
    },
  ]);

  assert.deepEqual(violations, [
    {
      line: 1,
      name: "direct CommandResult writer",
      path: "crates/example/src/lib.rs",
    },
  ]);
});
