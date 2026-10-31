// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

export type UniverseKey = number | "*";

type UniverseOverlapFlags = { inputOverlap: boolean; outputOverlap: boolean };

export type RouteConflictColumn = "source" | "target";

type RouteEndpointReference = {
  rowId: string;
  column: RouteConflictColumn;
};

type UniverseTargetState = {
  wildcardOwners: RouteEndpointReference[];
  addressOwners: Map<number, RouteEndpointReference[]>;
};

type TransportTargetState = {
  inputWildcardOwners: RouteEndpointReference[];
  inputAddressOwners: Map<number, RouteEndpointReference[]>;
  outputWildcardOwners: RouteEndpointReference[];
  outputAddressOwners: Map<number, RouteEndpointReference[]>;
};

type FixtureTargetState = Map<string, RouteEndpointReference[]>;

export type RouteOverlapAnalysis = {
  universeIds: Set<number>;
  overlapByUniverse: Map<UniverseKey, UniverseOverlapFlags>;
  routeUniverses: Map<string, Set<UniverseKey>>;
  conflictColumnsByRoute: Map<string, Set<RouteConflictColumn>>;
};

const MAX_UNIVERSE_RANGE_EXPANSION = 64;

function expandUniverseRange(
  range?: types.DmxRange,
): UniverseKey[] | "wildcard" | null {
  if (!range) return "wildcard";
  if (range.end < range.start) return null;

  const size = range.end - range.start + 1;
  if (size > MAX_UNIVERSE_RANGE_EXPANSION) return "wildcard";

  const universes: UniverseKey[] = [];
  for (let u = range.start; u <= range.end; u++) {
    universes.push(u);
  }
  return universes;
}

function collectUniversesFromInputSource(
  source: types.InputSource,
): UniverseKey[] {
  switch (source.type) {
    case "Transport":
    case "Console": {
      const expanded = expandUniverseRange(source.data.universe);
      if (expanded === "wildcard") return ["*"];
      return expanded ?? [];
    }
    case "Fixture":
      return [];
  }
}

function collectUniversesFromInputTarget(
  target: types.InputTarget,
): UniverseKey[] {
  switch (target.type) {
    case "Transport":
    case "Console": {
      const expanded = expandUniverseRange(target.data.universe);
      if (expanded === "wildcard") return ["*"];
      return expanded ?? [];
    }
    case "Fixture":
    case "Disabled":
      return [];
  }
}

function collectFixtureInputTargetKeys(target: types.InputTarget): string[] {
  if (target.type !== "Fixture") return [];
  const elementKey = target.data.element ?? "*";
  const paramKey = target.data.param ?? "*";
  return target.data.uids.map((uid) => `${uid}:${elementKey}:${paramKey}`);
}

function collectUniversesFromOutputSource(
  source: types.OutputSource,
): UniverseKey[] {
  switch (source.type) {
    case "Console": {
      const expanded = expandUniverseRange(source.data.universe);
      if (expanded === "wildcard") return ["*"];
      return expanded ?? [];
    }
    case "Fixture":
    case "FixtureBreak":
      return [];
  }
}

function collectUniversesFromOutputTarget(
  target: types.OutputTarget,
): UniverseKey[] {
  switch (target.type) {
    case "Transport":
    case "Console": {
      const expanded = expandUniverseRange(target.data.universe);
      if (expanded === "wildcard") return ["*"];
      return expanded ?? [];
    }
  }
}

function getExpandedUniversesForKeys(
  keys: Set<UniverseKey>,
  universeIds: Set<number>,
): UniverseKey[] {
  const specificUniverses = [...keys].filter((key) => key !== "*");
  if (specificUniverses.length > 0) {
    return specificUniverses;
  }
  if (keys.has("*")) {
    return ["*", ...Array.from(universeIds)];
  }
  return [...keys];
}

function addKnownUniverses(universeIds: Set<number>, keys: UniverseKey[]) {
  for (const key of keys) {
    if (key !== "*") universeIds.add(key);
  }
}

function ensureOverlapFlags(
  overlapsByUniverse: Map<UniverseKey, UniverseOverlapFlags>,
  universeKey: UniverseKey,
) {
  const existing = overlapsByUniverse.get(universeKey) ?? {
    inputOverlap: false,
    outputOverlap: false,
  };
  overlapsByUniverse.set(universeKey, existing);
  return existing;
}

function markRouteConflictColumn(
  conflictColumnsByRoute: Map<string, Set<RouteConflictColumn>>,
  reference: RouteEndpointReference,
) {
  const columns = conflictColumnsByRoute.get(reference.rowId) ?? new Set();
  columns.add(reference.column);
  conflictColumnsByRoute.set(reference.rowId, columns);
}

function markRouteConflictColumns(
  conflictColumnsByRoute: Map<string, Set<RouteConflictColumn>>,
  references: RouteEndpointReference[],
) {
  for (const reference of references) {
    markRouteConflictColumn(conflictColumnsByRoute, reference);
  }
}

function allUniverseTargetOwners(
  entry: UniverseTargetState,
): RouteEndpointReference[] {
  return [
    ...entry.wildcardOwners,
    ...Array.from(entry.addressOwners.values()).flat(),
  ];
}

function registerUniverseTargetAddress(
  conflictColumnsByRoute: Map<string, Set<RouteConflictColumn>>,
  entry: UniverseTargetState,
  address: number | undefined,
  owner: RouteEndpointReference,
): RouteEndpointReference[] {
  const conflictingOwners =
    address === undefined
      ? allUniverseTargetOwners(entry)
      : [...entry.wildcardOwners, ...(entry.addressOwners.get(address) ?? [])];

  if (conflictingOwners.length > 0) {
    markRouteConflictColumns(conflictColumnsByRoute, conflictingOwners);
    markRouteConflictColumn(conflictColumnsByRoute, owner);
  }

  if (address === undefined) {
    entry.wildcardOwners.push(owner);
  } else {
    const owners = entry.addressOwners.get(address) ?? [];
    owners.push(owner);
    entry.addressOwners.set(address, owners);
  }

  return conflictingOwners;
}

function registerInputTarget(
  overlapsByUniverse: Map<UniverseKey, UniverseOverlapFlags>,
  conflictColumnsByRoute: Map<string, Set<RouteConflictColumn>>,
  inputTargets: Map<UniverseKey, UniverseTargetState>,
  universeKey: UniverseKey,
  address: number | undefined,
  owner: RouteEndpointReference,
) {
  const overlapFlags = ensureOverlapFlags(overlapsByUniverse, universeKey);
  const entry = inputTargets.get(universeKey) ?? {
    wildcardOwners: [],
    addressOwners: new Map<number, RouteEndpointReference[]>(),
  };
  const conflictingOwners = registerUniverseTargetAddress(
    conflictColumnsByRoute,
    entry,
    address,
    owner,
  );
  if (conflictingOwners.length > 0) overlapFlags.inputOverlap = true;

  inputTargets.set(universeKey, entry);
}

function registerFixtureInputTarget(
  conflictColumnsByRoute: Map<string, Set<RouteConflictColumn>>,
  fixtureTargets: FixtureTargetState,
  targetKey: string,
  owner: RouteEndpointReference,
) {
  const owners = fixtureTargets.get(targetKey) ?? [];
  if (owners.length > 0) {
    markRouteConflictColumns(conflictColumnsByRoute, owners);
    markRouteConflictColumn(conflictColumnsByRoute, owner);
  }

  owners.push(owner);
  fixtureTargets.set(targetKey, owners);
}

function registerOutputConsoleTarget(
  overlapsByUniverse: Map<UniverseKey, UniverseOverlapFlags>,
  conflictColumnsByRoute: Map<string, Set<RouteConflictColumn>>,
  outputConsoleTargets: Map<UniverseKey, UniverseTargetState>,
  universeKey: UniverseKey,
  address: number | undefined,
  owner: RouteEndpointReference,
) {
  const overlapFlags = ensureOverlapFlags(overlapsByUniverse, universeKey);
  const entry = outputConsoleTargets.get(universeKey) ?? {
    wildcardOwners: [],
    addressOwners: new Map<number, RouteEndpointReference[]>(),
  };
  const conflictingOwners = registerUniverseTargetAddress(
    conflictColumnsByRoute,
    entry,
    address,
    owner,
  );
  if (conflictingOwners.length > 0) overlapFlags.outputOverlap = true;

  outputConsoleTargets.set(universeKey, entry);
}

function registerOutputTransportRoute(
  overlapsByUniverse: Map<UniverseKey, UniverseOverlapFlags>,
  conflictColumnsByRoute: Map<string, Set<RouteConflictColumn>>,
  outputTransportStats: Map<
    UniverseKey,
    Map<
      string,
      {
        consoleOwners: RouteEndpointReference[];
        otherOwners: RouteEndpointReference[];
      }
    >
  >,
  universeKey: UniverseKey,
  transport: string,
  isConsoleSource: boolean,
  owner: RouteEndpointReference,
) {
  const overlapFlags = ensureOverlapFlags(overlapsByUniverse, universeKey);
  const statsByTransport = outputTransportStats.get(universeKey) ?? new Map();
  const stat = statsByTransport.get(transport) ?? {
    consoleOwners: [],
    otherOwners: [],
  };

  if (isConsoleSource) stat.consoleOwners.push(owner);
  else stat.otherOwners.push(owner);

  statsByTransport.set(transport, stat);
  outputTransportStats.set(universeKey, statsByTransport);

  if (
    stat.consoleOwners.length > 0 &&
    (stat.otherOwners.length > 0 || stat.consoleOwners.length > 1)
  ) {
    overlapFlags.outputOverlap = true;
    markRouteConflictColumns(conflictColumnsByRoute, [
      ...stat.consoleOwners,
      ...stat.otherOwners,
    ]);
  }
}

function registerTransportTarget(
  overlapsByUniverse: Map<UniverseKey, UniverseOverlapFlags>,
  conflictColumnsByRoute: Map<string, Set<RouteConflictColumn>>,
  transportTargets: Map<string, TransportTargetState>,
  universeKey: UniverseKey,
  transport: string,
  address: number | undefined,
  direction: "input" | "output",
  owner: RouteEndpointReference,
) {
  const overlapFlags = ensureOverlapFlags(overlapsByUniverse, universeKey);
  const targetKey = `${transport}|${universeKey}`;
  const entry = transportTargets.get(targetKey) ?? {
    inputWildcardOwners: [],
    inputAddressOwners: new Map<number, RouteEndpointReference[]>(),
    outputWildcardOwners: [],
    outputAddressOwners: new Map<number, RouteEndpointReference[]>(),
  };

  const isInput = direction === "input";
  const ownEntry: UniverseTargetState = isInput
    ? {
        wildcardOwners: entry.inputWildcardOwners,
        addressOwners: entry.inputAddressOwners,
      }
    : {
        wildcardOwners: entry.outputWildcardOwners,
        addressOwners: entry.outputAddressOwners,
      };
  const otherEntry: UniverseTargetState = isInput
    ? {
        wildcardOwners: entry.outputWildcardOwners,
        addressOwners: entry.outputAddressOwners,
      }
    : {
        wildcardOwners: entry.inputWildcardOwners,
        addressOwners: entry.inputAddressOwners,
      };
  const sameDirectionConflicts = registerUniverseTargetAddress(
    conflictColumnsByRoute,
    ownEntry,
    address,
    owner,
  );
  const crossDirectionConflicts =
    address === undefined
      ? allUniverseTargetOwners(otherEntry)
      : [
          ...otherEntry.wildcardOwners,
          ...(otherEntry.addressOwners.get(address) ?? []),
        ];

  if (sameDirectionConflicts.length > 0) {
    if (isInput) overlapFlags.inputOverlap = true;
    else overlapFlags.outputOverlap = true;
  }
  if (crossDirectionConflicts.length > 0) {
    overlapFlags.outputOverlap = true;
    markRouteConflictColumns(conflictColumnsByRoute, [
      ...crossDirectionConflicts,
      owner,
    ]);
  }

  transportTargets.set(targetKey, entry);
}

export function computeRouteOverlapAnalysis(
  snapshot: types.RoutesSnapshot,
  activeUniverses: number[],
): RouteOverlapAnalysis {
  const universeIds = new Set<number>(activeUniverses);
  const overlapsByUniverse = new Map<UniverseKey, UniverseOverlapFlags>();
  const routeUniverses = new Map<string, Set<UniverseKey>>();
  const conflictColumnsByRoute = new Map<string, Set<RouteConflictColumn>>();

  const inputTargets = new Map<UniverseKey, UniverseTargetState>();
  const fixtureInputTargets: FixtureTargetState = new Map();
  const outputConsoleTargets = new Map<UniverseKey, UniverseTargetState>();
  const transportTargets = new Map<string, TransportTargetState>();
  const outputTransportStats = new Map<
    UniverseKey,
    Map<
      string,
      {
        consoleOwners: RouteEndpointReference[];
        otherOwners: RouteEndpointReference[];
      }
    >
  >();

  for (const route of snapshot.input) {
    addKnownUniverses(
      universeIds,
      collectUniversesFromInputSource(route.source),
    );
    addKnownUniverses(
      universeIds,
      collectUniversesFromInputTarget(route.target),
    );
  }
  for (const route of snapshot.output) {
    addKnownUniverses(
      universeIds,
      collectUniversesFromOutputSource(route.source),
    );
    addKnownUniverses(
      universeIds,
      collectUniversesFromOutputTarget(route.target),
    );
  }
  for (const route of snapshot.disabled) {
    addKnownUniverses(
      universeIds,
      collectUniversesFromInputSource(route.data.source),
    );
  }

  snapshot.input.forEach((route, index) => {
    const rowId = `input-${index}`;
    const keys = new Set<UniverseKey>([
      ...collectUniversesFromInputSource(route.source),
      ...collectUniversesFromInputTarget(route.target),
    ]);
    routeUniverses.set(
      rowId,
      new Set(getExpandedUniversesForKeys(keys, universeIds)),
    );

    if (route.target.type === "Console") {
      const targetUniverses = getExpandedUniversesForKeys(keys, universeIds);
      for (const universeKey of targetUniverses) {
        registerInputTarget(
          overlapsByUniverse,
          conflictColumnsByRoute,
          inputTargets,
          universeKey,
          route.target.data.address ?? undefined,
          { rowId, column: "target" },
        );
      }
    }

    if (route.target.type === "Transport") {
      const targetUniverses = getExpandedUniversesForKeys(keys, universeIds);
      for (const universeKey of targetUniverses) {
        registerTransportTarget(
          overlapsByUniverse,
          conflictColumnsByRoute,
          transportTargets,
          universeKey,
          route.target.data.target,
          route.target.data.address ?? undefined,
          "input",
          { rowId, column: "target" },
        );
      }
    }

    for (const targetKey of collectFixtureInputTargetKeys(route.target)) {
      registerFixtureInputTarget(
        conflictColumnsByRoute,
        fixtureInputTargets,
        targetKey,
        { rowId, column: "source" },
      );
    }
  });

  snapshot.output.forEach((route, index) => {
    const rowId = `output-${index}`;
    const keys = new Set<UniverseKey>([
      ...collectUniversesFromOutputSource(route.source),
      ...collectUniversesFromOutputTarget(route.target),
    ]);
    routeUniverses.set(
      rowId,
      new Set(getExpandedUniversesForKeys(keys, universeIds)),
    );

    const targetUniverses = getExpandedUniversesForKeys(keys, universeIds);

    if (route.target.type === "Console") {
      for (const universeKey of targetUniverses) {
        registerOutputConsoleTarget(
          overlapsByUniverse,
          conflictColumnsByRoute,
          outputConsoleTargets,
          universeKey,
          route.target.data.address ?? undefined,
          { rowId, column: "target" },
        );
      }
    }

    if (route.target.type === "Transport") {
      const isConsoleSource = route.source.type === "Console";
      for (const universeKey of targetUniverses) {
        registerOutputTransportRoute(
          overlapsByUniverse,
          conflictColumnsByRoute,
          outputTransportStats,
          universeKey,
          route.target.data.target,
          isConsoleSource,
          { rowId, column: "target" },
        );
        registerTransportTarget(
          overlapsByUniverse,
          conflictColumnsByRoute,
          transportTargets,
          universeKey,
          route.target.data.target,
          route.target.data.address ?? undefined,
          "output",
          { rowId, column: "target" },
        );
      }
    }
  });

  snapshot.disabled.forEach((route, index) => {
    const rowId = `disabled-${index}`;
    const keys = new Set<UniverseKey>(
      collectUniversesFromInputSource(route.data.source),
    );
    routeUniverses.set(
      rowId,
      new Set(getExpandedUniversesForKeys(keys, universeIds)),
    );

    if (route.data.source.type !== "Console") return;
    for (const universeKey of getExpandedUniversesForKeys(keys, universeIds)) {
      registerInputTarget(
        overlapsByUniverse,
        conflictColumnsByRoute,
        inputTargets,
        universeKey,
        route.data.source.data.address ?? undefined,
        { rowId, column: "source" },
      );
    }
  });

  return {
    universeIds,
    overlapByUniverse: overlapsByUniverse,
    routeUniverses,
    conflictColumnsByRoute,
  };
}
