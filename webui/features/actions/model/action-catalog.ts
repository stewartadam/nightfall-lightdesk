// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as types from "../../../types";

/** Resolves display names for object references stored in action arguments. */
export interface ActionTargetNames {
  /** Returns a display name for a clip UID, when known. */
  clip: (uid: string) => string | undefined;
  /** Returns a display name for a master UID, when known. */
  master: (uid: string) => string | undefined;
  /** Returns a display name for a timeline UID, when known. */
  timeline: (uid: string) => string | undefined;
  /** Returns a display name for a cue UID, when known. */
  cue: (uid: string) => string | undefined;
  /** Returns a display name for a panel ID, when known. */
  panel: (id: string) => string | undefined;
}

/** Normalizes a UID so hyphenated and simple forms compare equal. */
export function normalizeActionUid(uid: unknown): string {
  return String(uid).replace(/-/g, "").toLowerCase();
}

/** Returns the catalog entry registered for an action ID. */
export function findCatalogEntry(
  catalog: readonly types.ActionCatalogEntry[],
  id: string,
): types.ActionCatalogEntry | undefined {
  return catalog.find((entry) => entry.descriptor.id === id);
}

/**
 * Returns the input kind an action consumes.
 *
 * Actions missing from the catalog, such as client-hosted `ui.*` actions, fire once per trigger.
 */
export function actionInputKind(
  catalog: readonly types.ActionCatalogEntry[],
  action: types.ActionReference,
): types.ActionInputKind {
  return (
    findCatalogEntry(catalog, action.id)?.descriptor.input ??
    types.ActionInputKind.Trigger
  );
}

/** Returns whether an action may be bound to or invoked from a surface. */
export function actionAllowsSurface(
  entry: types.ActionCatalogEntry,
  surface: types.ActionSurface,
): boolean {
  return entry.descriptor.surfaces.includes(surface);
}

/**
 * Returns whether the surface may bind an action reference.
 *
 * Actions missing from the catalog, such as client-hosted `ui.*` actions, are left to the
 * backend to accept or reject.
 */
export function actionReferenceAllowsSurface(
  catalog: readonly types.ActionCatalogEntry[],
  action: types.ActionReference,
  surface: types.ActionSurface,
): boolean {
  const entry = findCatalogEntry(catalog, action.id);
  return !entry || actionAllowsSurface(entry, surface);
}

/**
 * Returns catalog entries a surface may bind whose input kind is one of the accepted kinds,
 * sorted by category and label for pickers.
 */
export function actionsAccepting(
  catalog: readonly types.ActionCatalogEntry[],
  inputKinds: readonly types.ActionInputKind[],
  surface: types.ActionSurface,
): types.ActionCatalogEntry[] {
  return catalog
    .filter(
      (entry) =>
        inputKinds.includes(entry.descriptor.input) &&
        actionAllowsSurface(entry, surface),
    )
    .sort(
      (left, right) =>
        left.descriptor.category.localeCompare(right.descriptor.category) ||
        left.descriptor.label.localeCompare(right.descriptor.label),
    );
}

/** Reads one argument value from an action reference's opaque arguments object. */
export function argumentValue(
  action: types.ActionReference,
  name: string,
): unknown {
  const argumentsObject = action.arguments as Record<string, unknown> | null;
  return argumentsObject && typeof argumentsObject === "object"
    ? argumentsObject[name]
    : undefined;
}

/** Formats one argument for display according to its parameter kind. */
export function formatArgument(
  parameter: types.ActionParameter,
  value: unknown,
  names: ActionTargetNames,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  switch (parameter.kind.type) {
    case "Clip":
      return names.clip(normalizeActionUid(value)) ?? "Unknown clip";
    case "Master":
      return names.master(normalizeActionUid(value)) ?? "Unknown master";
    case "Timeline":
      return names.timeline(normalizeActionUid(value)) ?? "Unknown timeline";
    case "Cue":
      return names.cue(normalizeActionUid(value)) ?? "Unknown cue";
    case "Panel":
      return names.panel(String(value)) ?? String(value);
    case "Control":
      return `Control ${value}`;
    case "Integer":
    case "Number":
    case "Text":
      return String(value);
  }
}

/**
 * Formats an action reference as its catalog label plus argument values.
 *
 * Unknown actions fall back to their raw ID so stale bindings stay visible.
 */
export function formatActionReference(
  action: types.ActionReference,
  catalog: readonly types.ActionCatalogEntry[],
  names: ActionTargetNames,
): string {
  const entry = findCatalogEntry(catalog, action.id);
  if (!entry) return action.id;
  const details = entry.descriptor.parameters
    .map((parameter) =>
      formatArgument(parameter, argumentValue(action, parameter.name), names),
    )
    .filter((detail): detail is string => detail !== undefined);
  return details.length > 0
    ? `${entry.descriptor.label}: ${details.join(", ")}`
    : entry.descriptor.label;
}

/** Returns whether every required parameter of the action has a value. */
export function hasRequiredArguments(
  descriptor: types.ActionDescriptor,
  argumentsObject: Record<string, unknown>,
): boolean {
  return descriptor.parameters.every(
    (parameter) =>
      !parameter.required ||
      (argumentsObject[parameter.name] !== undefined &&
        argumentsObject[parameter.name] !== ""),
  );
}

/** Builds an action reference, dropping empty optional arguments. */
export function buildActionReference(
  descriptor: types.ActionDescriptor,
  argumentsObject: Record<string, unknown>,
): types.ActionReference {
  const cleaned: Record<string, unknown> = {};
  for (const parameter of descriptor.parameters) {
    const value = argumentsObject[parameter.name];
    if (value !== undefined && value !== "") cleaned[parameter.name] = value;
  }
  return { id: descriptor.id, arguments: cleaned };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Normalizes argument values so UIDs compare equal regardless of hyphenation or case. */
function canonicalArgument(value: unknown): unknown {
  if (typeof value === "string" && UUID_PATTERN.test(value)) {
    return normalizeActionUid(value);
  }
  if (Array.isArray(value)) return value.map(canonicalArgument);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalArgument(entry)]),
    );
  }
  return value;
}

/** Returns whether two action references invoke the same action with the same arguments. */
export function actionReferencesEqual(
  left: types.ActionReference,
  right: types.ActionReference,
): boolean {
  return (
    left.id === right.id &&
    JSON.stringify(canonicalArgument(left.arguments)) ===
      JSON.stringify(canonicalArgument(right.arguments))
  );
}
