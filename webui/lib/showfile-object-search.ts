// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { RepeatIcon } from "@squidlab/phosphor-solid/repeat";
import type { AppIcon } from "../components/ui/icon";
import type {
  Blueprint,
  Clip,
  ColorPath,
  Cue,
  Fixture,
  FlowDefinition,
  Fx,
  Group,
  Identifiers,
  Master,
  SceneObject,
  Sequence,
  StepFx,
  StoredFxModule,
  Timecode,
  Timeline,
} from "../types";
import { REVEAL_OBJECT_CAPABILITY } from "./panel-capabilities";
import {
  type PanelComponentName,
  panelDefinitionByName,
  panelDefinitionHasCapability,
} from "./panel-definitions";

export type ShowfileObjectType =
  | "fixture"
  | "group"
  | "cue"
  | "sequence"
  | "fx"
  | "stepfx"
  | "fxModule"
  | "clip"
  | "flow"
  | "blueprint"
  | "colorPath"
  | "master"
  | "sceneObject"
  | "timecode"
  | "timeline";

export interface ShowfileObjectTypeDefinition {
  type: ShowfileObjectType;
  label: string;
  badge: string;
  panelId: string;
  componentName: PanelComponentName;
  panelTitle: string;
  aliases: readonly string[];
}

export interface ShowfileObjectResultTag {
  id: string;
  label: string;
  icon?: AppIcon;
  text?: string;
}

export interface ShowfileObjectSearchEntry {
  uid: string;
  type: ShowfileObjectType;
  typeLabel: string;
  badge: string;
  id: number;
  displayId?: string;
  label: string;
  description?: string;
  keywords: readonly string[];
  panelId: string;
  componentName: PanelComponentName;
  panelTitle: string;
  tags: readonly ShowfileObjectResultTag[];
}

export interface ShowfileObjectStoresSnapshot {
  fixtures: Record<string, Fixture>;
  groups: Record<string, Group>;
  cues: Record<string, Cue>;
  sequences: Record<string, Sequence>;
  fx: Record<string, Fx>;
  stepFx: Record<string, StepFx>;
  fxModules: Record<string, StoredFxModule>;
  clips: Record<string, [Clip, boolean]>;
  flows: Record<string, FlowDefinition>;
  blueprints: Record<string, Blueprint>;
  colorPaths: Record<string, ColorPath>;
  masters: Record<string, Master>;
  sceneObjects: Record<string, SceneObject>;
  timecodes: Record<string, [Timecode, unknown]>;
  timelines: Record<string, Timeline>;
}

interface RankedEntry {
  entry: ShowfileObjectSearchEntry;
  score: number;
}

/** Returns object-palette panel fields from the shared panel definition. */
function showfileObjectPanelFields(
  componentName: PanelComponentName,
): Pick<
  ShowfileObjectTypeDefinition,
  "componentName" | "panelId" | "panelTitle"
> {
  const definition = panelDefinitionByName(componentName);
  if (!panelDefinitionHasCapability(definition, REVEAL_OBJECT_CAPABILITY.id)) {
    throw new Error(
      `Panel ${definition.componentName} must declare reveal-object capability`,
    );
  }

  return {
    panelId: definition.panelId,
    componentName,
    panelTitle: definition.title,
  };
}

export const SHOWFILE_OBJECT_TYPE_DEFINITIONS: readonly ShowfileObjectTypeDefinition[] =
  [
    {
      type: "fixture",
      label: "Fixture",
      badge: "fixture",
      ...showfileObjectPanelFields("FixtureGrid"),
      aliases: ["fixture", "fixtures", "fix"],
    },
    {
      type: "group",
      label: "Group",
      badge: "group",
      ...showfileObjectPanelFields("GroupsPanel"),
      aliases: ["group", "groups"],
    },
    {
      type: "cue",
      label: "Cue",
      badge: "cue",
      ...showfileObjectPanelFields("CueList"),
      aliases: ["cue", "cues"],
    },
    {
      type: "sequence",
      label: "Sequence",
      badge: "sequence",
      ...showfileObjectPanelFields("SequenceList"),
      aliases: ["sequence", "sequences", "seq"],
    },
    {
      type: "fx",
      label: "FX",
      badge: "fx",
      ...showfileObjectPanelFields("FxList"),
      aliases: ["fx"],
    },
    {
      type: "stepfx",
      label: "Step FX",
      badge: "stepfx",
      ...showfileObjectPanelFields("FxList"),
      aliases: ["stepfx", "step-fx", "step"],
    },
    {
      type: "fxModule",
      label: "Module FX",
      badge: "module-fx",
      ...showfileObjectPanelFields("FxList"),
      aliases: ["modulefx", "module-fx", "fxmodule", "fx-module", "module"],
    },
    {
      type: "clip",
      label: "Clip",
      badge: "clip",
      ...showfileObjectPanelFields("ClipList"),
      aliases: ["clip", "clips", "exec"],
    },
    {
      type: "flow",
      label: "Flow",
      badge: "flow",
      ...showfileObjectPanelFields("FlowList"),
      aliases: ["flow", "flows"],
    },
    {
      type: "blueprint",
      label: "Blueprint",
      badge: "blueprint",
      ...showfileObjectPanelFields("BlueprintsPanel"),
      aliases: ["blueprint", "blueprints", "bp"],
    },
    {
      type: "colorPath",
      label: "Color Path",
      badge: "color",
      ...showfileObjectPanelFields("ColorPathPanel"),
      aliases: ["color", "colors", "colorpath", "color-path", "colorpaths"],
    },
    {
      type: "master",
      label: "Master",
      badge: "master",
      ...showfileObjectPanelFields("MastersPanel"),
      aliases: ["master", "masters"],
    },
    {
      type: "sceneObject",
      label: "Scene Object",
      badge: "object",
      ...showfileObjectPanelFields("SceneObjects"),
      aliases: ["object", "objects", "scene", "scene-object", "scene-objects"],
    },
    {
      type: "timecode",
      label: "Timecode",
      badge: "timecode",
      ...showfileObjectPanelFields("TimecodesPanel"),
      aliases: ["timecode", "timecodes", "tc"],
    },
    {
      type: "timeline",
      label: "Timeline",
      badge: "timeline",
      ...showfileObjectPanelFields("TimelinesPanel"),
      aliases: ["timeline", "timelines", "tl"],
    },
  ];

const typeDefinitionsByType = new Map(
  SHOWFILE_OBJECT_TYPE_DEFINITIONS.map((definition) => [
    definition.type,
    definition,
  ]),
);

const typeDefinitionsByAlias = new Map(
  SHOWFILE_OBJECT_TYPE_DEFINITIONS.flatMap((definition) =>
    definition.aliases.map((alias) => [alias, definition] as const),
  ),
);

/** Returns a showfile object type definition by canonical type. */
export function showfileObjectTypeDefinition(
  type: ShowfileObjectType,
): ShowfileObjectTypeDefinition {
  const definition = typeDefinitionsByType.get(type);
  if (!definition) {
    throw new Error(`Unknown showfile object type: ${type}`);
  }
  return definition;
}

/** Parses a complete leading type token followed by whitespace. */
export function parseShowfileObjectTypeToken(
  query: string,
): { definition: ShowfileObjectTypeDefinition; rest: string } | null {
  const match = query.match(/^(\S+)(\s+)(.*)$/u);
  if (!match) {
    return null;
  }

  const definition = typeDefinitionsByAlias.get(match[1].toLowerCase());
  if (!definition) {
    return null;
  }

  return { definition, rest: match[3] };
}

/** Builds searchable palette entries from current showfile stores. */
export function buildShowfileObjectSearchEntries(
  stores: ShowfileObjectStoresSnapshot,
): ShowfileObjectSearchEntry[] {
  const sequenceCueDisplayIds = new Map<string, string>();
  for (const sequence of Object.values(stores.sequences).sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  )) {
    for (const cueUid of sequence.steps) {
      if (sequenceCueDisplayIds.has(cueUid)) continue;
      const cue = stores.cues[cueUid];
      if (!cue) continue;
      sequenceCueDisplayIds.set(
        cueUid,
        `${sequence.identifiers.id}.${cue.identifiers.id}`,
      );
    }
  }

  return [
    ...Object.values(stores.fixtures).map((fixture) =>
      createEntry(
        "fixture",
        fixture.identifiers,
        [fixture.make, fixture.model, fixture.mode],
        {
          tags: fixtureResultTags(fixture),
        },
      ),
    ),
    ...Object.values(stores.groups).map((group) =>
      createEntry("group", group.identifiers, [group.description], {
        description: group.description,
      }),
    ),
    ...Object.values(stores.cues).map((cue) => {
      const description = optionalObjectString(cue, "description");
      const displayId = sequenceCueDisplayIds.get(cue.identifiers.uid);
      return createEntry("cue", cue.identifiers, [displayId, description], {
        description,
        displayId,
      });
    }),
    ...Object.values(stores.sequences).map((sequence) =>
      createEntry("sequence", sequence.identifiers, [], {
        tags: sequence.wrap
          ? [
              {
                id: "wrap",
                label: "Wrap sequence",
                icon: RepeatIcon,
              },
            ]
          : [],
      }),
    ),
    ...Object.values(stores.fx).map((fx) =>
      createEntry("fx", fx.identifiers, []),
    ),
    ...Object.values(stores.stepFx).map((stepFx) =>
      createEntry("stepfx", stepFx.identifiers, []),
    ),
    ...Object.values(stores.fxModules).map((fxModule) =>
      createEntry("fxModule", fxModule.identifiers, [fxModule.module_name], {
        description: fxModule.module_name,
      }),
    ),
    ...Object.values(stores.clips).map(([clip]) =>
      createEntry("clip", clip.identifiers, [], {
        tags: clipResultTags(clip),
      }),
    ),
    ...Object.values(stores.flows).map((flow) =>
      createEntry("flow", flow.identifiers, []),
    ),
    ...Object.values(stores.blueprints).map((blueprint) =>
      createEntry(
        "blueprint",
        blueprint.identifiers,
        Object.keys(blueprint.values),
      ),
    ),
    ...Object.values(stores.colorPaths).map((colorPath) =>
      createEntry("colorPath", colorPath.identifiers, [
        colorPath.interpolation_space,
      ]),
    ),
    ...Object.values(stores.masters).map((master) =>
      createEntry("master", master.identifiers, [
        master.kind,
        formatMasterTarget(master.target),
      ]),
    ),
    ...Object.values(stores.sceneObjects).map((sceneObject) =>
      createEntry(
        "sceneObject",
        sceneObject.identifiers,
        [
          formatSceneObjectType(sceneObject.objectType),
          sceneObjectLibraryName(sceneObject),
        ],
        {
          description: sceneObjectLibraryName(sceneObject),
        },
      ),
    ),
    ...Object.values(stores.timecodes).map(([timecode]) =>
      createEntry("timecode", timecode.identifiers, [
        timecode.rate,
        timecode.source,
      ]),
    ),
    ...Object.values(stores.timelines).map((timeline) =>
      createEntry("timeline", timeline.identifiers, [
        timeline.audio_path,
        timeline.tracks?.length,
      ]),
    ),
  ];
}

/** Filters and ranks showfile object entries for the object palette. */
export function filterShowfileObjectSearchEntries(
  entries: readonly ShowfileObjectSearchEntry[],
  query: string,
  activeType?: ShowfileObjectType,
): ShowfileObjectSearchEntry[] {
  const normalizedQuery = normalizeQuery(query);
  const scopedEntries = activeType
    ? entries.filter((entry) => entry.type === activeType)
    : entries;

  if (!normalizedQuery) {
    return [...scopedEntries].sort(compareEntries);
  }

  return scopedEntries
    .map((entry): RankedEntry | null => {
      const score = scoreEntry(
        entry,
        normalizedQuery,
        activeType !== undefined,
      );
      return score === null ? null : { entry, score };
    })
    .filter((ranked): ranked is RankedEntry => ranked !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return compareEntries(left.entry, right.entry);
    })
    .map((ranked) => ranked.entry);
}

/** Returns compact secondary text for a palette result row. */
export function showfileObjectResultDescription(
  entry: ShowfileObjectSearchEntry,
): string {
  return `${entry.typeLabel} ${entry.displayId ?? entry.id}`;
}

/** Returns the primary text shown for a palette result row. */
export function showfileObjectResultLabel(
  entry: ShowfileObjectSearchEntry,
): string {
  return entry.label.trim() || "Unnamed";
}

/** Formats scene-object variants for operator-facing search metadata. */
function formatSceneObjectType(type: SceneObject["objectType"]): string {
  switch (type) {
    case "truss":
      return "Truss";
    case "audience":
      return "Audience";
    case "stageElement":
      return "Stage Element";
    case "custom":
      return "Custom";
    default:
      return String(type);
  }
}

/** Returns the linked object-library name when a scene object has one. */
function sceneObjectLibraryName(sceneObject: SceneObject): string | undefined {
  const data = sceneObject.properties.data;
  if (!("libraryObjectName" in data)) {
    return undefined;
  }
  return typeof data.libraryObjectName === "string"
    ? data.libraryObjectName
    : undefined;
}

/** Formats a master target into search metadata without exposing raw UID payloads. */
function formatMasterTarget(target: Master["target"] | undefined): string {
  if (!target) return "All fixtures";
  if (target.type === "Instances") {
    return target.data.type === "All" ? "All instances" : "Clips";
  }
  switch (target.data.type) {
    case "All":
      return "All fixtures";
    case "Group":
      return "Group";
    case "Selection":
      return "Captured selection";
  }
}

/** Builds compact metadata tags that distinguish fixture profiles and modes. */
function fixtureResultTags(
  fixture: Fixture,
): readonly ShowfileObjectResultTag[] {
  return compactResultTags([
    nonEmptyString(fixture.model)
      ? {
          id: "fixture-profile",
          label: `${fixture.make} ${fixture.model}`.trim(),
          text: fixture.model.trim(),
        }
      : null,
    nonEmptyString(fixture.mode)
      ? {
          id: "fixture-mode",
          label: `Mode ${fixture.mode.trim()}`,
          text: fixture.mode.trim(),
        }
      : null,
  ]);
}

/** Builds compact metadata tags for enabled clip playback options. */
function clipResultTags(clip: Clip): readonly ShowfileObjectResultTag[] {
  return compactResultTags([
    clip.options?.auto_release
      ? {
          id: "auto-release",
          label: "Auto release",
          text: "AR",
        }
      : null,
    clip.options?.deactivate_on_sequence_end
      ? {
          id: "deactivate-on-sequence-end",
          label: "Deactivate on sequence end",
          text: "END",
        }
      : null,
  ]);
}

/** Removes disabled tag slots while preserving the exported tag shape. */
function compactResultTags(
  tags: readonly (ShowfileObjectResultTag | null)[],
): ShowfileObjectResultTag[] {
  return tags.filter((tag): tag is ShowfileObjectResultTag => tag !== null);
}

/** Reads an optional string field from generated types that may lag persisted data. */
function optionalObjectString(
  object: unknown,
  key: string,
): string | undefined {
  if (object === null || typeof object !== "object") {
    return undefined;
  }

  const value = (object as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Returns whether a string has non-whitespace display content. */
function nonEmptyString(value: string): boolean {
  return value.trim().length > 0;
}

/** Creates a normalized search entry from shared object identifiers. */
function createEntry(
  type: ShowfileObjectType,
  identifiers: Identifiers,
  keywords: readonly (string | number | undefined | null)[],
  options: {
    description?: string;
    displayId?: string;
    tags?: readonly ShowfileObjectResultTag[];
  } = {},
): ShowfileObjectSearchEntry {
  const definition = showfileObjectTypeDefinition(type);
  const tags = options.tags ?? [];
  return {
    uid: identifiers.uid,
    type,
    typeLabel: definition.label,
    badge: definition.badge,
    id: identifiers.id,
    displayId: options.displayId,
    label: identifiers.label,
    description: options.description,
    keywords: [
      definition.label,
      definition.badge,
      ...definition.aliases,
      ...keywords,
      ...tags.flatMap((tag) => [tag.text, tag.label]),
    ]
      .filter((keyword): keyword is string | number => keyword !== undefined)
      .map(String),
    panelId: definition.panelId,
    componentName: definition.componentName,
    panelTitle: definition.panelTitle,
    tags,
  };
}

/** Returns a whitespace-normalized lowercase phrase. */
function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** Returns the ranking score for a matching entry, or null when it does not match. */
function scoreEntry(
  entry: ShowfileObjectSearchEntry,
  normalizedQuery: string,
  isTypeScoped: boolean,
): number | null {
  const idText = String(entry.id);
  const normalizedLabel = entry.label.toLowerCase();
  const normalizedDescription = entry.description?.toLowerCase() ?? "";
  const normalizedKeywords = entry.keywords.join(" ").toLowerCase();

  if (/^\d+$/u.test(normalizedQuery)) {
    if (idText === normalizedQuery) {
      return 0;
    }
    if (idText.startsWith(normalizedQuery)) {
      return 1;
    }
    if (isTypeScoped) {
      return null;
    }
  }

  if (normalizedLabel.includes(normalizedQuery)) {
    return 2;
  }
  if (normalizedDescription.includes(normalizedQuery)) {
    return 3;
  }
  if (normalizedKeywords.includes(normalizedQuery)) {
    return 4;
  }
  if (idText.includes(normalizedQuery)) {
    return 5;
  }

  return null;
}

/** Sorts entries in stable operator-facing order. */
function compareEntries(
  left: ShowfileObjectSearchEntry,
  right: ShowfileObjectSearchEntry,
): number {
  const typeComparison =
    typeOrder(left.type) - typeOrder(right.type) || left.id - right.id;
  if (typeComparison !== 0) {
    return typeComparison;
  }
  return left.label.localeCompare(right.label);
}

/** Returns the configured display order for a showfile object type. */
function typeOrder(type: ShowfileObjectType): number {
  return SHOWFILE_OBJECT_TYPE_DEFINITIONS.findIndex(
    (definition) => definition.type === type,
  );
}
