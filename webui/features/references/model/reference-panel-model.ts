// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  ReferenceDomain,
  type ReferenceEntry,
  type ReferenceIssue,
  ReferenceIssueReason,
  type ReferenceOwner,
  ReferenceStatus,
  type ReferenceTarget,
} from "../../../types";

export const REFERENCE_ROW_HEIGHT = 36;

export type ReferenceColumnId =
  | "target"
  | "status"
  | "source"
  | "object"
  | "path";

export const REFERENCE_COLUMNS: Array<{
  id: ReferenceColumnId;
  label: string;
  defaultWidth: number;
  minWidth: number;
}> = [
  { id: "target", label: "Target", defaultWidth: 160, minWidth: 112 },
  { id: "status", label: "Status", defaultWidth: 112, minWidth: 96 },
  { id: "source", label: "Source", defaultWidth: 128, minWidth: 104 },
  { id: "object", label: "Object", defaultWidth: 220, minWidth: 128 },
  { id: "path", label: "Path", defaultWidth: 360, minWidth: 160 },
];

export type ReferencePanelTab = "references" | "health";
export type ReferenceDomainFilter = "all" | ReferenceDomain;

export const DOMAIN_OPTIONS: Array<{
  value: ReferenceDomainFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: ReferenceDomain.Group, label: "Groups" },
  { value: ReferenceDomain.Cue, label: "Cues" },
  { value: ReferenceDomain.Sequence, label: "Sequences" },
  { value: ReferenceDomain.Fx, label: "FX" },
  { value: ReferenceDomain.StepFx, label: "Step FX" },
  { value: ReferenceDomain.FxModule, label: "FX Modules" },
  { value: ReferenceDomain.Flow, label: "Flows" },
  { value: ReferenceDomain.Master, label: "Masters" },
  { value: ReferenceDomain.PatchBinding, label: "Patch Bindings" },
];

/** Names the object family of a reference's owner, as shown in the Source column. */
export function referenceDomainLabel(domain: ReferenceDomain): string {
  switch (domain) {
    case ReferenceDomain.Group:
      return "Group";
    case ReferenceDomain.Cue:
      return "Cue";
    case ReferenceDomain.Sequence:
      return "Sequence";
    case ReferenceDomain.Fx:
      return "FX";
    case ReferenceDomain.StepFx:
      return "Step FX";
    case ReferenceDomain.FxModule:
      return "FX Module";
    case ReferenceDomain.Flow:
      return "Flow";
    case ReferenceDomain.Master:
      return "Master";
    case ReferenceDomain.PatchBinding:
      return "Patch Binding";
  }
}

/** Describes why a reference is missing in the Health table's Issue column. */
export function referenceIssueReasonLabel(
  reason: ReferenceIssueReason,
): string {
  switch (reason) {
    case ReferenceIssueReason.MissingFixtureUid:
      return "Missing fixture UID";
    case ReferenceIssueReason.MissingFixtureId:
      return "Missing fixture ID";
    case ReferenceIssueReason.MissingFixtureElement:
      return "Missing element";
    case ReferenceIssueReason.MissingGroupUid:
      return "Missing group UID";
    case ReferenceIssueReason.MissingGroupId:
      return "Missing group";
    case ReferenceIssueReason.MissingGroupLabel:
      return "Missing group label";
    case ReferenceIssueReason.MissingBlueprintUid:
      return "Missing Blueprint UID";
    case ReferenceIssueReason.MissingOutputTarget:
      return "Missing output transport target";
  }
}

/** Formats the object or fixture a reference names, such as `Fixture 3.2` or `Group "Wash"`. */
export function referenceTargetLabel(target: ReferenceTarget): string {
  switch (target.type) {
    case "Fixture":
      // The engine sends a whole-fixture reference's element as null.
      return target.data.element_index == null
        ? `Fixture ${target.data.fixture_id}`
        : `Fixture ${target.data.fixture_id}.${target.data.element_index}`;
    case "FixtureUid":
      return `Fixture UID ${target.data.fixture_uid}`;
    case "Group":
      return `Group ${target.data.group_id}`;
    case "GroupUid":
      return `Group UID ${target.data.group_uid}`;
    case "GroupLabel":
      return `Group "${target.data.label}"`;
    case "Blueprint":
      return `Blueprint ${target.data.blueprint_uid}`;
    case "OutputTarget":
      return `Output transport target ${target.data.target}`;
  }
}

/** Formats the object holding a reference as `<id>: <label>`, as shown in the Object column. */
export function referenceOwnerLabel(owner: ReferenceOwner): string {
  return `${owner.id}: ${owner.label}`;
}

/**
 * Builds a key that identifies one row across report refreshes, so the grid keeps selection and
 * scroll position while the backend resends the list.
 */
export function referenceRowKey(row: ReferenceEntry | ReferenceIssue): string {
  return [
    row.source.domain,
    row.source.uid,
    row.path,
    referenceTargetLabel(row.target),
  ].join("\u0000");
}

/** Checks whether a reference row matches the selected domain. */
export function matchesReferenceDomain(
  domain: ReferenceDomain,
  filter: ReferenceDomainFilter,
): boolean {
  return filter === "all" || domain === filter;
}

/** Checks whether a reference or issue row's displayed text contains the free-text filter. */
export function matchesReferenceSearch(
  row: ReferenceEntry | ReferenceIssue,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [
    referenceDomainLabel(row.source.domain),
    row.source.id.toString(),
    row.source.label,
    row.path,
    referenceTargetLabel(row.target),
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/** Applies all reference-panel controls to reverse-reference rows. */
export function filterReferences(
  references: readonly ReferenceEntry[],
  domain: ReferenceDomainFilter,
  search: string,
  missingOnly: boolean,
): ReferenceEntry[] {
  return references.filter(
    (reference) =>
      matchesReferenceDomain(reference.source.domain, domain) &&
      matchesReferenceSearch(reference, search) &&
      (!missingOnly || reference.status === ReferenceStatus.Missing),
  );
}

/** Applies domain and text controls to object-health issue rows. */
export function filterReferenceIssues(
  issues: readonly ReferenceIssue[],
  domain: ReferenceDomainFilter,
  search: string,
): ReferenceIssue[] {
  return issues.filter(
    (issue) =>
      matchesReferenceDomain(issue.source.domain, domain) &&
      matchesReferenceSearch(issue, search),
  );
}
