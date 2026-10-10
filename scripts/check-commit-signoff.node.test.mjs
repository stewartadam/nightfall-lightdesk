// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { signoffProblem } from "./check-commit-signoff.mjs";

const author = { name: "Stewart Adam", email: "s.adam@diffingo.com" };

/** Verifies a sign-off by the author passes, regardless of email case or other trailers. */
test("author sign-off passes", () => {
  const message =
    "feat(webui:io): add a thing\n\nBody.\n\nSigned-off-by: Stewart Adam <S.Adam@diffingo.com>\nCo-Authored-By: Claude <noreply@anthropic.com>\n";

  assert.equal(signoffProblem(message, author), null);
});

/** Verifies a sign-off under another email of the same person is rejected, naming both. */
test("sign-off with a different email fails", () => {
  const message =
    "fix(webui:io): fix a thing\n\nSigned-off-by: Stewart Adam <stewart.e.adam@gmail.com>\n";

  const problem = signoffProblem(message, author);

  assert.match(problem, /stewart\.e\.adam@gmail\.com/);
  assert.match(problem, /Signed-off-by: Stewart Adam <s\.adam@diffingo\.com>/);
});

/** Verifies a commit with no sign-off is rejected with the trailer to add. */
test("missing sign-off fails", () => {
  const problem = signoffProblem("fix: thing\n", author);

  assert.match(problem, /no sign-off/);
});

/** Verifies sign-offs that only appear in git's comment template do not count. */
test("commented sign-off is ignored", () => {
  const message =
    "fix: thing\n\n# Signed-off-by: Stewart Adam <s.adam@diffingo.com>\n";

  assert.notEqual(signoffProblem(message, author), null);
});

/** Verifies autosquash commits are exempt since they are folded into a signed-off commit. */
test("fixup commits are exempt", () => {
  assert.equal(signoffProblem("fixup! fix: thing\n", author), null);
  assert.equal(signoffProblem("squash! fix: thing\n", author), null);
});
