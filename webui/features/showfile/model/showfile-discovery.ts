// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface AvailableShowfile {
  name: string;
  path: string;
  has_saved_snapshot?: boolean;
  hasSavedSnapshot?: boolean;
  modified_ms?: number | null;
  modifiedMs?: number | null;
  validation_status?: "unchecked";
  validationStatus?: "unchecked";
  load_error?: string | null;
  loadError?: string | null;
  draft?: AvailableShowfileDraft | null;
  revisions?: AvailableShowfileRevision[];
}

export interface AvailableShowfileDraft {
  showfile_name?: string;
  showfileName?: string;
  name: string;
  path: string;
  modified_ms?: number | null;
  modifiedMs?: number | null;
  saved_modified_ms?: number | null;
  savedModifiedMs?: number | null;
  validation_status?: "unchecked";
  validationStatus?: "unchecked";
  load_error?: string | null;
  loadError?: string | null;
}

export interface AvailableShowfileRevision {
  name: string;
  path: string;
  modified_ms?: number | null;
  modifiedMs?: number | null;
  validation_status?: "unchecked";
  validationStatus?: "unchecked";
  load_error?: string | null;
  loadError?: string | null;
}

export interface AvailableShowfilesResponse {
  showfiles: AvailableShowfile[];
}

type TimestampedShowfileItem =
  | AvailableShowfile
  | AvailableShowfileDraft
  | AvailableShowfileRevision;

type LoadableShowfileItem = TimestampedShowfileItem;

/** Reads the backend load error while tolerating snake-case response mocks. */
export function showfileLoadError(
  item: LoadableShowfileItem,
): string | null | undefined {
  return item.loadError ?? item.load_error;
}

/** Formats a showfile modified timestamp for operator-facing display. */
export function formatModifiedTime(modifiedMs?: number | null): string {
  if (typeof modifiedMs !== "number") return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(modifiedMs));
}

/** Reads the backend timestamp while tolerating legacy camelCase mocks. */
export function modifiedTimeMs(
  item: TimestampedShowfileItem,
): number | null | undefined {
  return item.modified_ms ?? item.modifiedMs;
}

/** Returns a finite timestamp from an available showfile item. */
export function numericModifiedTimeMs(
  item: TimestampedShowfileItem,
): number | null {
  const value = modifiedTimeMs(item);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Returns the newest timestamp represented by a showfile group. */
export function showfileGroupModifiedTimeMs(
  showfile: AvailableShowfile,
): number | null {
  const timestamps = [
    numericModifiedTimeMs(showfile),
    showfile.draft ? numericModifiedTimeMs(showfile.draft) : null,
    ...(showfile.revisions ?? []).map(numericModifiedTimeMs),
  ].filter((value): value is number => value !== null);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

/** Returns the showfile groups tied for the newest known update timestamp. */
export function mostRecentlyUpdatedShowfileNames(
  showfiles: AvailableShowfile[],
): Set<string> {
  const names = new Set<string>();
  let newestTimestamp = Number.NEGATIVE_INFINITY;
  for (const showfile of showfiles) {
    const timestamp = showfileGroupModifiedTimeMs(showfile);
    if (timestamp === null) continue;
    if (timestamp > newestTimestamp) {
      names.clear();
      newestTimestamp = timestamp;
    }
    if (timestamp === newestTimestamp) {
      names.add(showfile.name);
    }
  }
  return names;
}

/** Returns the canonical showfile name that owns a draft entry. */
export function draftShowfileName(
  draft: AvailableShowfileDraft,
  fallback: string,
): string {
  return draft.showfile_name ?? draft.showfileName ?? fallback;
}

/** Returns the saved showfile folder name used as the visible revision label. */
export function savedShowfileRevisionName(showfile: AvailableShowfile): string {
  return showfileRevisionPathLabel(
    showfile.path,
    `${showfile.name}.nightfall-show`,
  );
}

/** Returns a compact revision path, preserving draft and backup root folders. */
export function showfileRevisionPathLabel(
  path: string,
  fallback: string,
): string {
  const pathParts = path.split(/[\\/]/).filter(Boolean);
  const prefixedRootIndex = pathParts.findIndex((part) =>
    ["drafts", "backups"].includes(part),
  );
  if (prefixedRootIndex >= 0) {
    return pathParts.slice(prefixedRootIndex).join("/");
  }
  return pathParts[pathParts.length - 1] || fallback;
}

/** Returns whether a showfile has a saved snapshot row to display. */
export function hasSavedShowfileRevision(showfile: AvailableShowfile): boolean {
  const hasSavedSnapshot =
    showfile.has_saved_snapshot ?? showfile.hasSavedSnapshot;
  if (typeof hasSavedSnapshot === "boolean") return hasSavedSnapshot;
  return modifiedTimeMs(showfile) != null;
}
