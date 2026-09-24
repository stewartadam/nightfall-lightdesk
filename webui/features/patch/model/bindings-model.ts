// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BindingConflictColumn } from "../../../lib/binding-overlap";
import { normalizeFixtureUid } from "../../../lib/binding-utils";
import {
  alwaysVisibleColumnMeta,
  columnVisibilityMeta,
  type VisibilityGridColumn,
} from "../../../lib/datagrid-column-visibility";
import type { FilterableGridColumn } from "../../../lib/datagrid-filtering";
import * as types from "../../../types";

export type BindingDeleteFilter = {
  source: types.BindingEndpoint;
  target: types.BindingEndpoint;
  priority: number;
  clone: boolean;
};

export type BindingRow = {
  id: string;
  kind: string;
  source: string;
  target: string;
  priority: number;
  clone: boolean;
  deleteFilter: BindingDeleteFilter | null;
};

export type ConflictTooltipState = {
  id: number;
  content: string;
  anchorRect: DOMRect;
};

export function isBindingConflictColumn(
  columnId: string | undefined,
): columnId is BindingConflictColumn {
  return columnId === "source" || columnId === "target";
}

export const DEFAULT_COLUMNS: FilterableGridColumn<
  BindingRow,
  VisibilityGridColumn
>[] = [
  {
    title: "Type",
    id: "type",
    width: 100,
    filter: { value: (row) => row.kind },
    ...alwaysVisibleColumnMeta("Identity", "Type"),
  },
  {
    title: "Source",
    id: "source",
    width: 280,
    filter: { value: (row) => row.source },
    ...columnVisibilityMeta("Binding", "Source"),
  },
  {
    title: "Target",
    id: "target",
    width: 280,
    filter: { value: (row) => row.target },
    ...columnVisibilityMeta("Binding", "Target"),
  },
  {
    title: "Priority",
    id: "priority",
    width: 90,
    filter: { kind: "number", value: (row) => row.priority },
    ...columnVisibilityMeta("Binding", "Priority"),
  },
  {
    title: "Clone",
    id: "clone",
    width: 70,
    filter: { kind: "boolean", value: (row) => row.clone },
    ...columnVisibilityMeta("Binding", "Clone"),
  },
];

export function formatRange(range?: types.DmxRange | null): string {
  if (!range) return "*";
  if (range.start === range.end) return String(range.start);
  return `${range.start}-${range.end}`;
}

export function formatUniverseAddress(
  universe?: types.DmxRange | null,
  address?: number | null,
): string {
  const hasUniverse = universe != null;
  const hasAddress = address != null;
  if (!hasUniverse && !hasAddress) return "";
  const universePart = formatRange(universe);
  const addressPart = address == null ? "*" : String(address);
  return `${universePart}.${addressPart}`;
}

export const TRANSPORT_LABELS: Record<types.BindingTransport, string> = {
  [types.BindingTransport.Sacn]: "sACN",
  [types.BindingTransport.ArtNet]: "Art-Net",
  [types.BindingTransport.Udmx]: "USB",
};

export function normalizeBindingTransport(
  transport: unknown,
): types.BindingTransport | null {
  if (typeof transport !== "string") {
    return null;
  }

  const value = transport.trim().toLowerCase();
  if (value === types.BindingTransport.Sacn) {
    return types.BindingTransport.Sacn;
  }
  if (value === types.BindingTransport.ArtNet) {
    return types.BindingTransport.ArtNet;
  }
  if (value === types.BindingTransport.Udmx) {
    return types.BindingTransport.Udmx;
  }
  return null;
}

export function formatBindingTransport(transport: unknown): string {
  const normalized = normalizeBindingTransport(transport);
  if (normalized) {
    return TRANSPORT_LABELS[normalized];
  }
  return String(transport ?? "Unknown");
}

/** Converts a physical input transport to the command endpoint target ID. */
export function bindingTransportToTargetId(
  transport: types.BindingTransport,
): string {
  if (transport === types.BindingTransport.ArtNet) return "artnet";
  return transport;
}

/** Formats a network DMX output target identifier for binding tables. */
export function formatOutputTargetId(target: string): string {
  if (target === "sacn") return "sACN";
  if (target === "artnet") return "Art-Net";
  if (target === "udmx") return "USB";
  return target;
}

/**
 * Normalizes a fixture UID field that may arrive as a scalar, array, or empty value.
 */
export function toUidArray(uids: unknown): unknown[] {
  if (Array.isArray(uids)) {
    return uids;
  }
  if (uids == null) {
    return [];
  }
  return [uids];
}

export function formatFixtureList(
  uids: unknown,
  fixtureMap: Record<string, types.Fixture>,
): string {
  const uidArray = toUidArray(uids);
  if (uidArray.length === 0) {
    return "Unknown";
  }

  return uidArray
    .map((uid) => {
      const normalized = normalizeFixtureUid(uid);
      const fixture = fixtureMap[normalized];
      if (!fixture) return normalized;
      const label = fixture.identifiers.label;
      if (label) {
        return `${fixture.identifiers.id} (${label})`;
      }
      return String(fixture.identifiers.id);
    })
    .join(", ");
}

export function formatFixtureEndpoint(
  uids: unknown,
  fixtureMap: Record<string, types.Fixture>,
  element?: number,
  param?: string,
): string {
  const fixtureList = formatFixtureList(uids, fixtureMap);
  const elementSuffix = element ? `.${element}` : "";
  const paramSuffix = param ? `.${param}` : "";
  return `Fixture ${fixtureList}${elementSuffix}${paramSuffix}`;
}

/**
 * Converts fixture UIDs to fixture IDs, returning null if any UID is unresolved.
 */
export function toFixtureIds(
  uids: types.Uuid[],
  fixtureMap: Record<string, types.Fixture>,
): number[] | null {
  if (uids.length === 0) {
    return null;
  }

  const ids: number[] = [];
  for (const uid of uids) {
    const fixture = fixtureMap[normalizeFixtureUid(uid)];
    if (!fixture) {
      return null;
    }
    ids.push(fixture.identifiers.id);
  }

  return ids;
}

export function toInputSourceEndpoint(
  source: types.InputSource,
  fixtureMap: Record<string, types.Fixture>,
): types.BindingEndpoint | null {
  switch (source.type) {
    case "Transport":
      return {
        type: "Transport",
        data: {
          target: bindingTransportToTargetId(source.data.transport),
          universe: source.data.universe,
          address: source.data.address,
        },
      };
    case "Console":
      return { type: "Console", data: { ...source.data } };
    case "Fixture": {
      const ids = toFixtureIds(source.data.uids, fixtureMap);
      if (!ids) return null;
      return {
        type: "Fixture",
        data: {
          ids,
          element: source.data.element,
          param: source.data.param,
        },
      };
    }
  }
}

export function toInputTargetEndpoint(
  target: types.InputTarget,
  fixtureMap: Record<string, types.Fixture>,
): types.BindingEndpoint | null {
  switch (target.type) {
    case "Transport":
      return { type: "Transport", data: { ...target.data } };
    case "Console":
      return { type: "Console", data: { ...target.data } };
    case "Fixture": {
      const ids = toFixtureIds(target.data.uids, fixtureMap);
      if (!ids) return null;
      return {
        type: "Fixture",
        data: {
          ids,
          element: target.data.element,
          param: target.data.param,
        },
      };
    }
    case "Disabled":
      return { type: "Disabled" };
  }
}

export function toOutputSourceEndpoint(
  source: types.OutputSource,
  fixtureMap: Record<string, types.Fixture>,
): types.BindingEndpoint | null {
  switch (source.type) {
    case "Console":
      return { type: "Console", data: { ...source.data } };
    case "Fixture": {
      const ids = toFixtureIds(source.data.uids, fixtureMap);
      if (!ids) return null;
      return {
        type: "Fixture",
        data: {
          ids,
          element: source.data.element,
          param: source.data.param,
        },
      };
    }
    case "FixtureBreak": {
      const ids = toFixtureIds(source.data.uids, fixtureMap);
      if (!ids) return null;
      return {
        type: "FixtureBreak",
        data: { ids, dmx_break: source.data.dmx_break },
      };
    }
  }
}

export function toOutputTargetEndpoint(
  target: types.OutputTarget,
): types.BindingEndpoint {
  switch (target.type) {
    case "Transport":
      return { type: "Transport", data: { ...target.data } };
    case "Console":
      return { type: "Console", data: { ...target.data } };
    case "Disabled":
      return { type: "Disabled" };
  }
}

export function toInputBindingDeleteFilter(
  binding: types.InputBinding,
  fixtureMap: Record<string, types.Fixture>,
): BindingDeleteFilter | null {
  const source = toInputSourceEndpoint(binding.source, fixtureMap);
  const target = toInputTargetEndpoint(binding.target, fixtureMap);
  if (!source || !target) {
    return null;
  }
  return {
    source,
    target,
    priority: binding.priority,
    clone: binding.clone,
  };
}

export function toOutputBindingDeleteFilter(
  binding: types.OutputBinding,
  fixtureMap: Record<string, types.Fixture>,
): BindingDeleteFilter | null {
  const source = toOutputSourceEndpoint(binding.source, fixtureMap);
  const target = toOutputTargetEndpoint(binding.target);
  if (!source) {
    return null;
  }
  return {
    source,
    target,
    priority: binding.priority,
    clone: binding.clone,
  };
}

export function toDisabledBindingDeleteFilter(
  binding: types.DisabledBinding,
  fixtureMap: Record<string, types.Fixture>,
): BindingDeleteFilter | null {
  if (binding.type === "Input") {
    const source = toInputSourceEndpoint(binding.data.source, fixtureMap);
    if (!source) {
      return null;
    }
    return {
      source,
      target: { type: "Disabled" },
      priority: binding.data.priority,
      clone: binding.data.clone,
    };
  }

  const source = toOutputSourceEndpoint(binding.data.source, fixtureMap);
  if (!source) {
    return null;
  }
  return {
    source,
    target: { type: "Disabled" },
    priority: binding.data.priority,
    clone: binding.data.clone,
  };
}

export function formatInputSource(
  source: types.InputSource,
  fixtureMap: Record<string, types.Fixture>,
): string {
  switch (source.type) {
    case "Transport": {
      const transport = formatBindingTransport(source.data.transport);
      const universeAddress = formatUniverseAddress(
        source.data.universe,
        source.data.address,
      );
      return universeAddress ? `${transport} ${universeAddress}` : transport;
    }
    case "Console": {
      const universeAddress = formatUniverseAddress(
        source.data.universe,
        source.data.address,
      );
      return universeAddress ? `Console ${universeAddress}` : "Console";
    }
    case "Fixture":
      return formatFixtureEndpoint(
        source.data?.uids,
        fixtureMap,
        source.data.element,
        source.data.param,
      );
  }
}

export function formatInputTarget(
  target: types.InputTarget,
  fixtureMap: Record<string, types.Fixture>,
): string {
  switch (target.type) {
    case "Transport": {
      const transport = formatOutputTargetId(target.data.target);
      const universeAddress = formatUniverseAddress(
        target.data.universe,
        target.data.address,
      );
      return universeAddress ? `${transport} ${universeAddress}` : transport;
    }
    case "Console": {
      const universeAddress = formatUniverseAddress(
        target.data.universe,
        target.data.address,
      );
      return universeAddress ? `Console ${universeAddress}` : "Console";
    }
    case "Fixture":
      return formatFixtureEndpoint(
        target.data?.uids,
        fixtureMap,
        target.data.element,
        target.data.param,
      );
    case "Disabled":
      return "Disabled";
  }
}

export function formatOutputSource(
  source: types.OutputSource,
  fixtureMap: Record<string, types.Fixture>,
): string {
  switch (source.type) {
    case "Fixture":
      return formatFixtureEndpoint(
        source.data?.uids,
        fixtureMap,
        source.data.element,
        source.data.param,
      );
    case "FixtureBreak":
      return `${formatFixtureEndpoint(source.data.uids, fixtureMap)} break ${source.data.dmx_break}`;
    case "Console": {
      const universeAddress = formatUniverseAddress(
        source.data.universe,
        source.data.address,
      );
      return universeAddress ? `Console ${universeAddress}` : "Console";
    }
  }
}

export function formatOutputTarget(target: types.OutputTarget): string {
  switch (target.type) {
    case "Transport": {
      const transport = formatOutputTargetId(target.data.target);
      const universeAddress = formatUniverseAddress(
        target.data.universe,
        target.data.address,
      );
      return universeAddress ? `${transport} ${universeAddress}` : transport;
    }
    case "Console": {
      const universeAddress = formatUniverseAddress(
        target.data.universe,
        target.data.address,
      );
      return universeAddress ? `Console ${universeAddress}` : "Console";
    }
    case "Disabled":
      return "Disabled";
  }
}

export function toInputBindingRow(
  binding: types.InputBinding,
  fixtureMap: Record<string, types.Fixture>,
  id: string,
): BindingRow {
  return {
    id,
    kind: "Input",
    source: formatInputSource(binding.source, fixtureMap),
    target: formatInputTarget(binding.target, fixtureMap),
    priority: binding.priority,
    clone: binding.clone,
    deleteFilter: toInputBindingDeleteFilter(binding, fixtureMap),
  };
}

export function toOutputBindingRow(
  binding: types.OutputBinding,
  fixtureMap: Record<string, types.Fixture>,
  id: string,
): BindingRow {
  return {
    id,
    kind: "Output",
    source: formatOutputSource(binding.source, fixtureMap),
    target: formatOutputTarget(binding.target),
    priority: binding.priority,
    clone: binding.clone,
    deleteFilter: toOutputBindingDeleteFilter(binding, fixtureMap),
  };
}

export function toDisabledBindingRow(
  binding: types.DisabledBinding,
  fixtureMap: Record<string, types.Fixture>,
  id: string,
): BindingRow {
  if (binding.type === "Input") {
    return {
      id,
      kind: "Input",
      source: formatInputSource(binding.data.source, fixtureMap),
      target: "Disabled",
      priority: binding.data.priority,
      clone: binding.data.clone,
      deleteFilter: toDisabledBindingDeleteFilter(binding, fixtureMap),
    };
  }

  return {
    id,
    kind: "Output",
    source: formatOutputSource(binding.data.source, fixtureMap),
    target: "Disabled",
    priority: binding.data.priority,
    clone: binding.data.clone,
    deleteFilter: toDisabledBindingDeleteFilter(binding, fixtureMap),
  };
}
