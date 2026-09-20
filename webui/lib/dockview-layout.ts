// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  DockviewApi,
  EdgeGroupPosition,
  IDockviewPanel,
  SerializedDockview,
  SerializedEdgeGroups,
} from "dockview";

export const SERIALIZED_LAYOUT_VERSION = 2;

export interface SerializedLayout {
  version: number;
  layout: unknown;
  panels: Array<{
    id: string;
    title: string;
    params?: unknown;
  }>;
}

/** Compares arrangements independently of ordering and focus, optionally excluding automatically computed geometry. */
export function serializedLayoutKey(
  layout: SerializedLayout,
  includeGeometry = true,
): string {
  /** Canonicalizes Dockview structure while retaining panel parameters verbatim. */
  const canonical = (value: unknown, structure = true): unknown => {
    if (Array.isArray(value))
      return value.map((entry) => canonical(entry, structure));
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .flatMap((key) => {
          if (
            structure &&
            ((!includeGeometry && LAYOUT_GEOMETRY_FIELDS.has(key)) ||
              key === "activeGroup" ||
              (key === "activeView" && Array.isArray(record.views)))
          )
            return [];
          return [[key, canonical(record[key], structure && key !== "params")]];
        }),
    );
  };
  return JSON.stringify(
    canonical({
      version: layout.version,
      layout: layout.layout,
      panels: [...layout.panels]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((panel) => ({ ...panel, params: panel.params ?? {} })),
    }),
  );
}

const LAYOUT_GEOMETRY_FIELDS = new Set([
  "width",
  "height",
  "size",
  "minimumSize",
  "maximumSize",
  "position",
]);

/** Extracts Dockview geometry separately from content and topology for explicit resize gestures. */
export function serializedLayoutGeometryKey(layout: SerializedLayout): string {
  const dimensions: unknown[] = [];
  /** Visits only Dockview structure so panel parameters never become layout dimensions. */
  const visit = (value: unknown, path: string[]) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (key === "params") continue;
      if (LAYOUT_GEOMETRY_FIELDS.has(key))
        dimensions.push([[...path, key], child]);
      else visit(child, [...path, key]);
    }
  };
  visit(layout.layout, []);
  return JSON.stringify(dimensions);
}

const DEFAULT_EDGE_GROUPS = {
  bottom: {
    collapsed: true,
    groupId: "edge-Console",
    size: 260,
    visible: false,
  },
  left: {
    collapsed: true,
    groupId: "edge-Clips",
    size: 550,
    visible: false,
  },
  right: {
    collapsed: true,
    groupId: "edge-Properties",
    size: 340,
    visible: false,
  },
} as const;

type DefaultEdgeGroupPosition = keyof typeof DEFAULT_EDGE_GROUPS;

interface DockviewApiWithShellInternals {
  component?: {
    _shellManager?: {
      toJSON(): SerializedEdgeGroups;
    };
  };
}

interface SerializedEdgeGroupLayout {
  collapsed?: boolean;
  group?: unknown;
  size?: unknown;
  visible?: boolean;
  [key: string]: unknown;
}

/**
 * Returns a deep clone of the serialized layout with current migrations applied.
 */
export function cloneSerializedLayout(
  layout: SerializedLayout,
): SerializedLayout {
  const cloned = JSON.parse(JSON.stringify(layout)) as SerializedLayout;
  return {
    version: cloned.version,
    layout: migrateSerializedDockviewLayout(cloned.layout),
    panels: cloned.panels,
  };
}

/**
 * Captures the current Dockview state in the app's restorable layout format.
 */
export function createSerializedLayout(dockApi: DockviewApi): SerializedLayout {
  const layoutData = withLiveEdgeGroupShellLayout(
    dockApi,
    migrateSerializedDockviewLayout(dockApi.toJSON()),
  );
  const panels = dockApi.panels.map((panel: IDockviewPanel) => ({
    id: panel.id,
    title: panel.title ?? "",
    params: panel.params || {},
  }));

  return {
    version: SERIALIZED_LAYOUT_VERSION,
    layout: layoutData,
    panels,
  };
}

/** Builds an empty workspace at the current viewport size without altering live panels. */
export function createBlankSerializedLayout(
  dockApi: DockviewApi,
): SerializedLayout {
  const { grid } = dockApi.toJSON();
  const layout: SerializedDockview = {
    grid: {
      width: grid.width,
      height: grid.height,
      orientation: grid.orientation,
      root: { type: "branch", data: [], size: grid.root.size },
    },
    panels: {},
  };
  return cloneSerializedLayout({
    version: SERIALIZED_LAYOUT_VERSION,
    layout,
    panels: [],
  });
}

/**
 * Returns whether a value matches the current serialized layout envelope.
 */
export function isSerializedLayout(value: unknown): value is SerializedLayout {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SerializedLayout>;
  return (
    candidate.version === SERIALIZED_LAYOUT_VERSION &&
    "layout" in candidate &&
    Array.isArray(candidate.panels)
  );
}

/**
 * Returns a cloned serialized layout when the value is valid.
 */
export function sanitizeSerializedLayout(
  value: unknown,
): SerializedLayout | null {
  if (!isSerializedLayout(value)) {
    return null;
  }

  return cloneSerializedLayout(value);
}

/**
 * Restores a serialized Dockview layout through one shared app restore path.
 */
export function restoreSerializedLayout(
  api: DockviewApi,
  layout: SerializedLayout,
): void {
  const restored = cloneSerializedLayout(layout);
  resetSerializedEdgeGroupsBeforeRestore(api, restored.layout);
  api.fromJSON(restored.layout as SerializedDockview);
}

/**
 * Merges live Dockview shell state into a serialized layout payload.
 */
function withLiveEdgeGroupShellLayout(
  api: DockviewApi,
  layout: unknown,
): unknown {
  const liveEdgeGroups = (
    api as unknown as DockviewApiWithShellInternals
  ).component?._shellManager?.toJSON();
  if (!liveEdgeGroups || !isDockviewSerializedLayout(layout)) {
    return layout;
  }

  const edgeGroups =
    layout.edgeGroups !== null && typeof layout.edgeGroups === "object"
      ? { ...layout.edgeGroups }
      : {};

  for (const [position, edgeGroup] of Object.entries(liveEdgeGroups)) {
    edgeGroups[position] = {
      ...(edgeGroups[position] ?? {}),
      ...edgeGroup,
    };
  }

  return {
    ...layout,
    edgeGroups,
  };
}

/**
 * Returns whether a value has Dockview's serialized root grid shape.
 */
function isDockviewSerializedLayout(value: unknown): value is {
  edgeGroups?: Record<string, unknown>;
  grid: { root?: unknown };
  panels?: unknown;
} {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const layout = value as {
    grid?: unknown;
    panels?: unknown;
  };
  if (layout.grid === null || typeof layout.grid !== "object") {
    return false;
  }

  const grid = layout.grid as { root?: unknown };
  return "root" in grid && layout.panels !== undefined;
}

/**
 * Returns a hidden empty Dockview edge group record for legacy layout migration.
 */
function createDefaultEdgeGroupLayout(
  config: (typeof DEFAULT_EDGE_GROUPS)[keyof typeof DEFAULT_EDGE_GROUPS],
) {
  return {
    collapsed: config.collapsed,
    group: {
      id: config.groupId,
      views: [],
    },
    size: config.size,
    visible: config.visible,
  };
}

/**
 * Returns a finite serialized edge size or the app default for that edge slot.
 */
function normalizedEdgeGroupSize(
  position: DefaultEdgeGroupPosition,
  size: unknown,
): number {
  return typeof size === "number" && Number.isFinite(size)
    ? size
    : DEFAULT_EDGE_GROUPS[position].size;
}

/**
 * Ensures an existing Dockview edge group record carries restorable size data.
 */
function normalizeSerializedEdgeGroupLayout(
  position: DefaultEdgeGroupPosition,
  value: unknown,
): SerializedEdgeGroupLayout {
  const defaults = createDefaultEdgeGroupLayout(DEFAULT_EDGE_GROUPS[position]);
  if (value === null || typeof value !== "object") {
    return defaults;
  }

  const edgeGroup = value as SerializedEdgeGroupLayout;
  return {
    ...edgeGroup,
    size: normalizedEdgeGroupSize(position, edgeGroup.size),
  };
}

/**
 * Normalizes saved edge groups and renamed panel components before Dockview restores them.
 */
function migrateSerializedDockviewLayout(layout: unknown): unknown {
  if (!isDockviewSerializedLayout(layout)) {
    return layout;
  }

  const edgeGroups =
    layout.edgeGroups !== null && typeof layout.edgeGroups === "object"
      ? { ...layout.edgeGroups }
      : {};

  for (const [position, config] of Object.entries(DEFAULT_EDGE_GROUPS)) {
    edgeGroups[position] =
      position in edgeGroups
        ? normalizeSerializedEdgeGroupLayout(
            position as DefaultEdgeGroupPosition,
            edgeGroups[position],
          )
        : createDefaultEdgeGroupLayout(config);
  }

  return {
    ...layout,
    panels: Object.fromEntries(
      Object.entries(layout.panels as SerializedDockview["panels"]).map(
        ([id, panel]) => [
          id,
          panel.contentComponent === "ExecutorList"
            ? { ...panel, contentComponent: "ClipList" }
            : panel,
        ],
      ),
    ),
    edgeGroups,
  };
}

/**
 * Returns serialized edge group data from a Dockview layout payload.
 */
function serializedEdgeGroupsFromLayout(
  layout: unknown,
): SerializedEdgeGroups | undefined {
  if (layout === null || typeof layout !== "object") {
    return undefined;
  }

  const candidate = layout as { edgeGroups?: unknown };
  return candidate.edgeGroups !== null &&
    typeof candidate.edgeGroups === "object"
    ? (candidate.edgeGroups as SerializedEdgeGroups)
    : undefined;
}

/**
 * Removes stale edge shell slots before Dockview recreates serialized ones.
 */
function resetSerializedEdgeGroupsBeforeRestore(
  api: DockviewApi,
  layout: unknown,
): void {
  const edgeGroups = serializedEdgeGroupsFromLayout(layout);
  if (!edgeGroups) return;

  for (const [position, edgeGroup] of Object.entries(edgeGroups) as [
    EdgeGroupPosition,
    SerializedEdgeGroupLayout,
  ][]) {
    if (edgeGroup && api.getEdgeGroup(position)) {
      api.removeEdgeGroup(position);
    }
  }
}
