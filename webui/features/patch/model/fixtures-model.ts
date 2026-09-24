// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BindingConflictColumn } from "../../../lib/binding-overlap";
import { normalizeFixtureUid } from "../../../lib/binding-utils";
import type * as types from "../../../types";
import type { BindingRow } from "./bindings-model";
export type FixtureGroupRow = {
  rowKind: "fixture";
  fixtureUid: string;
  fixtureLabel: string;
  disabled: boolean;
  bindingCounts: { input: number; output: number; disabled: number };
  inputOverlap: boolean;
  outputOverlap: boolean;
  bindingRows: BindingRow[];
  isExpanded: boolean;
};

export type FixtureBindingRow = {
  rowKind: "binding";
  fixtureUid: string;
  binding: BindingRow;
  conflictColumns: Set<BindingConflictColumn>;
};

export type FixtureDisplayRow = FixtureGroupRow | FixtureBindingRow;

export type ConflictTooltipState = {
  id: number;
  content: string;
  anchorRect: DOMRect;
};

export const DISABLED_TEXT_COLOR = "#6b7280";

export function stableUniverseKey(range?: types.DmxRange): string {
  if (!range) return "*";
  if (range.start === range.end) return `${range.start}`;
  return `${range.start}-${range.end}`;
}

export function stableOutputTargetKey(
  target: types.OutputTarget,
): string | null {
  switch (target.type) {
    case "Transport":
      return `transport:${target.data.target}:${stableUniverseKey(
        target.data.universe,
      )}:${target.data.address ?? "*"}`;
    case "Console":
      return `console:${stableUniverseKey(target.data.universe)}:${target.data.address ?? "*"}`;
    case "Disabled":
      return null;
  }
}

/**
 * Extracts normalized fixture UIDs from fixture-based input binding sources.
 */
export function fixtureUidsFromInputSource(
  source: types.InputSource,
): Set<string> {
  if (source.type !== "Fixture") return new Set();
  return new Set(source.data.uids.map((uid) => normalizeFixtureUid(uid)));
}

/**
 * Extracts normalized fixture UIDs from fixture-based input binding targets.
 */
export function fixtureUidsFromInputTarget(
  target: types.InputTarget,
): Set<string> {
  if (target.type !== "Fixture") return new Set();
  return new Set(target.data.uids.map((uid) => normalizeFixtureUid(uid)));
}

/**
 * Extracts normalized fixture UIDs from fixture-based output binding sources,
 * including additional DMX break sources.
 */
export function fixtureUidsFromOutputSource(
  source: types.OutputSource,
): Set<string> {
  if (source.type !== "Fixture" && source.type !== "FixtureBreak") {
    return new Set();
  }
  return new Set(source.data.uids.map((uid) => normalizeFixtureUid(uid)));
}

export function inputBindingTouchesFixture(
  binding: types.InputBinding,
  fixtureUid: string,
): boolean {
  const sourceUids = fixtureUidsFromInputSource(binding.source);
  if (sourceUids.has(fixtureUid)) return true;
  const targetUids = fixtureUidsFromInputTarget(binding.target);
  return targetUids.has(fixtureUid);
}

export function outputBindingTouchesFixture(
  binding: types.OutputBinding,
  fixtureUid: string,
): boolean {
  const sourceUids = fixtureUidsFromOutputSource(binding.source);
  return sourceUids.has(fixtureUid);
}

export function disabledBindingTouchesFixture(
  binding: types.DisabledBinding,
  fixtureUid: string,
): boolean {
  if (binding.type === "Input") {
    const uids = fixtureUidsFromInputSource(binding.data.source);
    return uids.has(fixtureUid);
  }
  const uids = fixtureUidsFromOutputSource(binding.data.source);
  return uids.has(fixtureUid);
}

export function formatFixtureGroupLabel(fixture: types.Fixture): string {
  const label = fixture.identifiers.label;
  if (label) return `Fixture ${fixture.identifiers.id} (${label})`;
  return `Fixture ${fixture.identifiers.id}`;
}

export function formatGroupWithChevron(
  isExpanded: boolean,
  label: string,
): string {
  return `${isExpanded ? "▼" : "▶"} ${label}`;
}

/** Returns whether a fixtures tab cell represents a patch conflict. */
export function fixtureDisplayCellHasConflict(
  row: FixtureDisplayRow,
  columnId: string | undefined,
): boolean {
  if (row.rowKind === "binding") {
    return (
      (columnId === "source" || columnId === "target") &&
      row.conflictColumns.has(columnId)
    );
  }

  return (
    (columnId === "source" && row.inputOverlap) ||
    (columnId === "target" && row.outputOverlap)
  );
}
