// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getAttributeMetadata } from "../../../lib/attribute-metadata";
import type * as types from "../../../types";

export interface BlueprintAttributeGroup {
  category: types.AttributeCategory;
  attributes: string[];
}

/** Converts a typed attribute into the string key used by Blueprint value records. */
function attributeKey(attribute: types.Attribute): string {
  return attribute.type === "Custom" ? attribute.data.label : attribute.type;
}

/** Returns one Blueprint's logical values independently of fixture selection. */
export function blueprintLogicalValues(
  blueprint: types.Blueprint,
): Record<string, types.ValueSource> {
  return { ...blueprint.values };
}

/** Resolves the current values selected by a live Blueprint application. */
export function selectedBlueprintValues(
  blueprint: types.Blueprint,
  selector: types.BlueprintSelector,
): Record<string, types.ValueSource> {
  return Object.fromEntries(
    Object.entries(blueprintLogicalValues(blueprint)).filter(([attribute]) => {
      switch (selector.type) {
        case "All":
          return true;
        case "Attribute":
          return attribute === attributeKey(selector.data);
        case "Category":
          return getAttributeMetadata(attribute)?.category === selector.data;
      }
      return false;
    }),
  );
}

/** Returns a compact operator-facing description of a live selector. */
export function blueprintSelectorLabel(
  selector: types.BlueprintSelector,
): string {
  switch (selector.type) {
    case "All":
      return "All";
    case "Attribute":
      return attributeKey(selector.data);
    case "Category":
      return selector.data;
  }
}

/** Returns Blueprint attribute keys in stable display order. */
export function blueprintAttributeNames(blueprint: types.Blueprint): string[] {
  return Object.keys(blueprintLogicalValues(blueprint)).sort((left, right) =>
    left.localeCompare(right),
  );
}

/** Groups one Blueprint's logical attributes by canonical category in display order. */
export function blueprintAttributeGroups(
  blueprint: types.Blueprint,
): BlueprintAttributeGroup[] {
  const groups = new Map<types.AttributeCategory, string[]>();
  for (const attribute of blueprintAttributeNames(blueprint)) {
    const category =
      getAttributeMetadata(attribute)?.category ??
      ("Other" as types.AttributeCategory);
    const attributes = groups.get(category) ?? [];
    attributes.push(attribute);
    groups.set(category, attributes);
  }

  const categoryOrder = [
    "Dimmer",
    "Position",
    "Gobo",
    "Color",
    "Beam",
    "Focus",
    "Control",
    "Other",
  ] as types.AttributeCategory[];
  return categoryOrder.flatMap((category) => {
    const attributes = groups.get(category);
    return attributes ? [{ category, attributes }] : [];
  });
}

/** Reports whether a cue body or part contains a live reference to one Blueprint. */
function cueReferencesBlueprint(cue: types.Cue, blueprintUid: string): boolean {
  return [
    ...cue.instructions,
    ...(cue.parts ?? []).flatMap((part) => part.instructions),
  ].some(
    (instruction) =>
      instruction.cue_instruction.blueprint_application?.blueprint_uid ===
      blueprintUid,
  );
}

/** Counts stored cue and embedded sequence definitions depending on one Blueprint. */
export function blueprintDependentCueCount(
  blueprintUid: string,
  cues: Record<string, types.Cue>,
  sequences: Record<string, types.Sequence>,
): number {
  const cueCount = Object.values(cues).filter((cue) =>
    cueReferencesBlueprint(cue, blueprintUid),
  ).length;
  const embeddedCount = Object.values(sequences).filter(
    (sequence) =>
      cueReferencesBlueprint(sequence.setup_cue, blueprintUid) ||
      cueReferencesBlueprint(sequence.release_cue, blueprintUid),
  ).length;
  return cueCount + embeddedCount;
}
