// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  ReferenceAuditDomain,
  ReferenceEntry,
  ReferenceIssue,
} from "../../../lib/reference-audit";

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
export type ReferenceDomainFilter = "all" | ReferenceAuditDomain;

export const DOMAIN_OPTIONS: Array<{
  value: ReferenceDomainFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "group", label: "Groups" },
  { value: "cue", label: "Cues" },
  { value: "sequence", label: "Sequences" },
  { value: "fx", label: "FX" },
  { value: "stepFx", label: "Step FX" },
  { value: "fxModule", label: "FX Modules" },
  { value: "flow", label: "Flows" },
  { value: "patchBinding", label: "Patch Bindings" },
];

/** Checks whether a reference row matches the selected domain. */
export function matchesReferenceDomain(
  domain: ReferenceAuditDomain,
  filter: ReferenceDomainFilter,
): boolean {
  return filter === "all" || domain === filter;
}

/** Checks whether a reference or issue row matches the free-text filter. */
export function matchesReferenceSearch(
  row: ReferenceEntry | ReferenceIssue,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [
    row.source.kindLabel,
    row.source.id.toString(),
    row.source.label,
    row.path,
    row.targetLabel,
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/** Applies all reference-panel controls to reverse-reference rows. */
export function filterReferences(
  references: ReferenceEntry[],
  domain: ReferenceDomainFilter,
  search: string,
  missingOnly: boolean,
): ReferenceEntry[] {
  return references.filter(
    (reference) =>
      matchesReferenceDomain(reference.source.domain, domain) &&
      matchesReferenceSearch(reference, search) &&
      (!missingOnly || reference.status === "missing"),
  );
}

/** Applies domain and text controls to object-health issue rows. */
export function filterReferenceIssues(
  issues: ReferenceIssue[],
  domain: ReferenceDomainFilter,
  search: string,
): ReferenceIssue[] {
  return issues.filter(
    (issue) =>
      matchesReferenceDomain(issue.source.domain, domain) &&
      matchesReferenceSearch(issue, search),
  );
}
