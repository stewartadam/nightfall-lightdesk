// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MacroRunPhase } from "../../../types";
import {
  applyMacroTextPatch,
  createEmptyMacro,
  firstCommandLine,
  macroBodyLines,
  macroDisplayName,
  macroRunLabel,
  macroRunStatus,
  nextAvailableMacroId,
} from "./macro-model";

/** The preview skips blank lines and trims the first command. */
test("firstCommandLine returns the first non-blank line", () => {
  assert.equal(
    firstCommandLine("\n  \n  group 1 int 50\nsleep 2s"),
    "group 1 int 50",
  );
  assert.equal(firstCommandLine(""), "");
  assert.equal(firstCommandLine(undefined), "");
});

/** Body lines keep the line numbers the operator sees, so problems point at the right line. */
test("macroBodyLines numbers typed lines and skips blank ones", () => {
  assert.deepEqual(macroBodyLines("a\r\n\nb; c\n"), [
    { line: 1, text: "a" },
    { line: 3, text: "b; c" },
  ]);
});

/** New macros take the lowest free ID and get the default label. */
test("createEmptyMacro uses the first free ID", () => {
  const existing = [1, 2, 4].map(createEmptyMacro);
  assert.equal(nextAvailableMacroId(existing, [3]), 5);
  const id = nextAvailableMacroId(existing);
  assert.equal(id, 3);
  const macro = createEmptyMacro(id);
  assert.equal(macro.identifiers.label, "Macro 3");
  assert.equal(macro.identifiers.uid.includes("-"), false);
  assert.equal(
    macroDisplayName({
      ...macro,
      identifiers: { ...macro.identifiers, label: " " },
    }),
    "Macro 3",
  );
});

/** Run lookups match the macro's UID, and the label names the line and one-based step. */
test("macroRunStatus and macroRunLabel describe a live run", () => {
  const macro = createEmptyMacro(1);
  const run = {
    macro_uid: macro.identifiers.uid,
    phase: MacroRunPhase.Press,
    line: 3,
    statement: 1,
    statement_count: 4,
  };
  assert.equal(macroRunStatus([run], macro), run);
  assert.equal(macroRunStatus([run], createEmptyMacro(2)), undefined);
  assert.equal(macroRunLabel(run), "Running line 3 (step 2 of 4)");
  assert.equal(
    macroRunLabel({ ...run, phase: MacroRunPhase.Release }),
    "Releasing line 3 (step 2 of 4)",
  );
});

/** A patch replaces only its own fields, and the label lands in the identifiers. */
test("applyMacroTextPatch merges label and bodies", () => {
  const macro = {
    ...createEmptyMacro(1),
    commands: "a",
    release_commands: "b",
  };
  const patched = applyMacroTextPatch(macro, { label: "Up", commands: "c" });
  assert.equal(patched.identifiers.label, "Up");
  assert.equal(patched.identifiers.uid, macro.identifiers.uid);
  assert.equal(patched.commands, "c");
  assert.equal(patched.release_commands, "b");
});
