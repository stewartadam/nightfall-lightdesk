// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createShowObjectUid,
  nextAvailableIdentifierId,
} from "../../../lib/sequence-factory";
import {
  type Macro,
  type MacroCommand,
  MacroRunPhase,
  type MacroRunStatus,
} from "../../../types";

/** Sorts macros by numeric showfile ID without mutating the store map. */
export function sortMacrosById(
  macros: Readonly<Record<string, Macro>>,
): Macro[] {
  return Object.values(macros).sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  );
}

/** Returns the name a macro is shown under: its label, or its number when it has none. */
export function macroDisplayName(macro: Macro): string {
  return macro.identifiers.label.trim() || `Macro ${macro.identifiers.id}`;
}

/**
 * Finds the lowest free macro ID, also skipping IDs in `pending`: macros already sent to
 * the engine whose store update hasn't arrived yet, so quick repeated adds don't collide.
 */
export function nextAvailableMacroId(
  macros: Iterable<Macro>,
  pending: Iterable<number> = [],
): number {
  const pendingObjects = [...pending].map((id) => ({ identifiers: { id } }));
  return nextAvailableIdentifierId([...macros, ...pendingObjects]);
}

/** Builds an empty macro with a fresh UID in the simple (dashless) form the engine stores. */
export function createEmptyMacro(id: number): Macro {
  return {
    identifiers: {
      id,
      uid: createShowObjectUid(),
      label: `Macro ${id}`,
    },
    commands: "",
    release_commands: "",
  };
}

/** Returns the first non-blank line of a body, for previews in cards and rows. */
export function firstCommandLine(body: string | undefined): string {
  return (
    (body ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** Finds the live run of `macro`, if any of its bodies is running. */
export function macroRunStatus(
  runs: readonly MacroRunStatus[],
  macro: Macro,
): MacroRunStatus | undefined {
  return runs.find((run) => run.macro_uid === macro.identifiers.uid);
}

/**
 * Describes a run's progress, for example "Running line 3 (step 2 of 4)". Steps count
 * statements, which differ from lines when a line holds several statements.
 */
export function macroRunLabel(run: MacroRunStatus): string {
  const verb = run.phase === MacroRunPhase.Release ? "Releasing" : "Running";
  return `${verb} line ${run.line} (step ${run.statement + 1} of ${run.statement_count})`;
}

/** A macro field the Properties editor edits as text. */
export type MacroTextField = "label" | "commands" | "release_commands";

/** Text edits to some of a macro's fields, keyed by field. */
export type MacroTextPatch = Partial<Record<MacroTextField, string>>;

/** Reads one editable text field of `macro`; the label lives in its identifiers. */
export function readMacroTextField(
  macro: Macro,
  field: MacroTextField,
): string {
  return field === "label" ? macro.identifiers.label : (macro[field] ?? "");
}

/** Returns `macro` with every field in `patch` replaced, leaving the rest untouched. */
export function applyMacroTextPatch(
  macro: Macro,
  patch: MacroTextPatch,
): Macro {
  const { label, ...bodies } = patch;
  return {
    ...macro,
    ...bodies,
    identifiers:
      label === undefined ? macro.identifiers : { ...macro.identifiers, label },
  };
}

/** Builds the command that stores `macro` as given, used for every edit of its fields. */
export function buildStoreMacroCommand(macro: Macro): MacroCommand {
  return { type: "StoreMacro", data: macro };
}

/** Builds the command that renumbers a macro. */
export function buildRenameMacroCommand(
  id: number,
  newId: number,
): MacroCommand {
  return { type: "RenameMacro", data: { id, new_id: newId } };
}

/** Builds the command that deletes a macro, stopping it if it runs. */
export function buildDeleteMacroCommand(id: number): MacroCommand {
  return { type: "DeleteMacro", data: id };
}

/** Builds the command that runs a macro's press body. */
export function buildStartMacroCommand(id: number): MacroCommand {
  return { type: "StartMacro", data: id };
}

/** Builds the command that stops every running body of a macro. */
export function buildStopMacroCommand(id: number): MacroCommand {
  return { type: "StopMacro", data: id };
}

/** One problem the command grammar found in a macro body. */
export interface MacroLineProblem {
  /** One-based line the problem is on. */
  line: number;
  /** The statement the grammar rejected. */
  statement: string;
  /** What the grammar says is wrong. */
  message: string;
}

/** Splits a body into its typed lines, numbered from one, skipping blank lines. */
export function macroBodyLines(body: string): { line: number; text: string }[] {
  return body
    .split(/\r?\n/)
    .map((text, index) => ({ line: index + 1, text }))
    .filter((entry) => entry.text.trim().length > 0);
}
