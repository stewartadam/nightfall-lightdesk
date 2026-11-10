// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import * as types from "../../../types";

/** Whether the rig import dialog is open. */
export const rigImportDialogOpen = atom(false);

/** Opens the rig import dialog. */
export function openRigImportDialog(): void {
  rigImportDialogOpen.set(true);
}

/** How the numbering control is set: which strategy and the number it uses. */
export type NumberingChoice = "FromFile" | "Offset" | "Sequential";

/** Builds the numbering option sent to the engine from the dialog's controls. */
export function numberingOption(
  choice: NumberingChoice,
  value: number,
): types.FixtureNumbering {
  const amount = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  switch (choice) {
    case "Offset":
      return { type: "Offset", data: { by: amount } };
    case "Sequential":
      return { type: "Sequential", data: { start: Math.max(1, amount) } };
    default:
      return { type: "FromFile" };
  }
}

/** Short words for a fixture type's status, as the dialog's type table shows them. */
export function fixtureTypeStatusLabel(
  status: types.FixtureTypeStatus,
): string {
  switch (status.type) {
    case "InLibrary":
      return "In library";
    case "Embedded":
      return "From file";
    case "Mapped":
      return "Stand-in";
    case "Missing":
      return "Missing";
    case "Unreadable":
      return "Unreadable";
  }
}

/** Whether a fixture type needs the user to pick a library fixture to stand in for it. */
export function fixtureTypeNeedsChoice(
  status: types.FixtureTypeStatus,
): boolean {
  return status.type === "Missing" || status.type === "Unreadable";
}

/** Short words for what the import does with a fixture. */
export function fixtureStatusLabel(status: types.FixtureImportStatus): string {
  switch (status) {
    case types.FixtureImportStatus.New:
      return "New";
    case types.FixtureImportStatus.Update:
      return "Update";
    case types.FixtureImportStatus.Unchanged:
      return "Unchanged";
    case types.FixtureImportStatus.AlreadyInShow:
      return "In show, kept";
    case types.FixtureImportStatus.RepeatedInFile:
      return "Repeated UUID";
    case types.FixtureImportStatus.NeedsFixtureType:
      return "Needs fixture type";
    case types.FixtureImportStatus.NeedsMode:
      return "Needs mode";
  }
}

/** Formats a fixture's patch as `universe.address`, one entry per break. */
export function formatPatch(patch: readonly types.PatchPreview[]): string {
  if (patch.length === 0) return "Unpatched";
  return patch
    .map((entry) =>
      patch.length > 1
        ? `${entry.universe}.${entry.address} (break ${entry.dmxBreak})`
        : `${entry.universe}.${entry.address}`,
    )
    .join(", ");
}

/** Formats a placement position in metres, rounded to centimetres. */
export function formatPosition(placement: types.FixturePlacement): string {
  const { x, y, z } = placement.position;
  return [x, y, z].map((value) => value.toFixed(2)).join(", ");
}

/** Identifies a library fixture revision in a select's value. */
export function libraryKey(fixture: types.AvailableFixtureInfo): string {
  return JSON.stringify([fixture.make, fixture.model, fixture.asset_etag]);
}

/**
 * Replaces the stand-in for `spec` with the library fixture `key` (from {@link libraryKey}) and
 * its first mode, or removes the stand-in when `key` is empty or unknown.
 */
export function withTypeMapping(
  mappings: readonly types.FixtureTypeMapping[],
  spec: string,
  key: string,
  library: readonly types.AvailableFixtureInfo[],
): types.FixtureTypeMapping[] {
  const others = mappings.filter((mapping) => mapping.spec !== spec);
  const fixture = library.find((candidate) => libraryKey(candidate) === key);
  const mode = fixture?.modes[0];
  if (!fixture || mode === undefined) return others;
  return [
    ...others,
    {
      spec,
      make: fixture.make,
      model: fixture.model,
      revision: fixture.asset_etag,
      mode,
    },
  ];
}

/** Changes the mode of the stand-in for `spec`, if it has one. */
export function withMappingMode(
  mappings: readonly types.FixtureTypeMapping[],
  spec: string,
  mode: string,
): types.FixtureTypeMapping[] {
  return mappings.map((mapping) =>
    mapping.spec === spec ? { ...mapping, mode } : mapping,
  );
}

/** Group source choices in the order the dialog's select lists them, with their labels. */
export const GROUP_SOURCE_OPTIONS: readonly {
  value: types.RigGroupSource;
  label: string;
}[] = [
  { value: types.RigGroupSource.Auto, label: "Hanging positions, else layers" },
  { value: types.RigGroupSource.HangingPositions, label: "Hanging positions" },
  { value: types.RigGroupSource.Layers, label: "Layers" },
  { value: types.RigGroupSource.Classes, label: "Classes" },
  { value: types.RigGroupSource.None, label: "No groups" },
];

/** Counts fixtures in words: "1 fixture", "3 fixtures". */
function fixtures(count: number): string {
  return `${count} fixture${count === 1 ? "" : "s"}`;
}

/** What the change check, the blocked-import banner and the done toast read from a preview. */
type PreviewCounts = {
  newFixtures: number;
  updatedFixtures: number;
  sceneryChanges: number;
  groups: readonly unknown[];
};

/** Counts scenery objects in words: "1 scenery object", "17 scenery objects". */
function sceneryObjects(count: number): string {
  return `${count} scenery object${count === 1 ? "" : "s"}`;
}

/**
 * Why a preview has nothing to import, for the banner shown while the import button is
 * disabled, or undefined when the import would change the show. Fixture types that need a
 * library fixture come first, since choosing one is what unblocks their fixtures; then
 * fixtures that differ but are kept because updates are off; then a show that already
 * matches the file.
 */
export function importBlockedReason(
  preview: PreviewCounts & {
    fixtures: readonly { status: types.FixtureImportStatus }[];
    scenery: readonly { status: types.SceneryImportStatus }[];
  },
): string | undefined {
  if (previewHasChanges(preview)) return undefined;
  const count = (status: types.FixtureImportStatus) =>
    preview.fixtures.filter((fixture) => fixture.status === status).length;
  const needsType = count(types.FixtureImportStatus.NeedsFixtureType);
  if (needsType > 0) {
    return `${fixtures(needsType)} ${needsType === 1 ? "has" : "have"} a fixture type Nightfall can't load. Choose a library fixture for ${needsType === 1 ? "it" : "them"} on the Fixture types tab.`;
  }
  const needsMode = count(types.FixtureImportStatus.NeedsMode);
  if (needsMode > 0) {
    return `${fixtures(needsMode)} ${needsMode === 1 ? "uses a mode its" : "use modes their"} fixture type doesn't have, so ${needsMode === 1 ? "it is" : "they are"} left out.`;
  }
  const kept = count(types.FixtureImportStatus.AlreadyInShow);
  if (kept > 0) {
    return `${fixtures(kept)} in the show ${kept === 1 ? "differs" : "differ"} from the file, but updating fixtures already in the show is turned off.`;
  }
  if (
    preview.scenery.some(
      (object) => object.status === types.SceneryImportStatus.Skipped,
    )
  ) {
    return "The file's scenery is left out because importing trusses and scenery is turned off.";
  }
  if (preview.fixtures.length === 0 && preview.scenery.length === 0) {
    return "The file has no fixtures or scenery to import.";
  }
  return "Nothing to import: the show already matches this file.";
}

/** Whether committing a preview would change the show at all. */
export function previewHasChanges(preview: PreviewCounts): boolean {
  return (
    preview.newFixtures > 0 ||
    preview.updatedFixtures > 0 ||
    preview.sceneryChanges > 0 ||
    preview.groups.length > 0
  );
}

/** Toast text after an import, naming what changed and the file. */
export function importDoneMessage(
  preview: PreviewCounts & { fileName: string },
): string {
  const parts: string[] = [];
  if (preview.newFixtures > 0)
    parts.push(`added ${fixtures(preview.newFixtures)}`);
  if (preview.updatedFixtures > 0) {
    parts.push(`updated ${fixtures(preview.updatedFixtures)}`);
  }
  if (preview.sceneryChanges > 0) {
    parts.push(`imported ${sceneryObjects(preview.sceneryChanges)}`);
  }
  if (parts.length === 0) parts.push("refreshed the groups");
  const sentence = parts.join(" and ");
  return `${sentence[0]?.toUpperCase()}${sentence.slice(1)} from ${preview.fileName}`;
}

/** Short words for what the import does with a truss, support or layer of scenery. */
export function sceneryStatusLabel(status: types.SceneryImportStatus): string {
  switch (status) {
    case types.SceneryImportStatus.New:
      return "New";
    case types.SceneryImportStatus.Update:
      return "Update";
    case types.SceneryImportStatus.Unchanged:
      return "Unchanged";
    case types.SceneryImportStatus.AlreadyInShow:
      return "In show, kept";
    case types.SceneryImportStatus.Skipped:
      return "Skipped";
    case types.SceneryImportStatus.NoModel:
      return "No model";
  }
}

/** The lists the import review shows, one per tab. */
export type RigImportTab = "types" | "groups" | "scenery" | "fixtures";

/** Tab names in the import review. */
export const RIG_IMPORT_TAB_LABELS: Readonly<Record<RigImportTab, string>> = {
  types: "Fixture types",
  groups: "Groups",
  scenery: "Scenery",
  fixtures: "Fixtures",
};

/**
 * The tabs a preview has rows for, in review order. Fixture types and fixtures always show;
 * groups and scenery only when the import makes groups or the file has scenery.
 */
export function rigImportTabs(
  preview: Pick<types.RigImportPreview, "groups" | "scenery">,
): RigImportTab[] {
  const tabs: RigImportTab[] = ["types"];
  if (preview.groups.length > 0) tabs.push("groups");
  if (preview.scenery.length > 0) tabs.push("scenery");
  tabs.push("fixtures");
  return tabs;
}

/** How many rows a tab lists, shown beside its name. */
export function rigImportTabCount(
  preview: Pick<
    types.RigImportPreview,
    "fixtureTypes" | "groups" | "scenery" | "fixtures"
  >,
  tab: RigImportTab,
): number {
  switch (tab) {
    case "types":
      return preview.fixtureTypes.length;
    case "groups":
      return preview.groups.length;
    case "scenery":
      return preview.scenery.length;
    case "fixtures":
      return preview.fixtures.length;
  }
}

/** Short words for what a scenery row stands for. */
export function sceneryKindLabel(kind: types.RigSceneryKind): string {
  switch (kind) {
    case types.RigSceneryKind.Truss:
      return "Truss";
    case types.RigSceneryKind.Support:
      return "Support";
    case types.RigSceneryKind.Layer:
      return "Layer scenery";
  }
}
