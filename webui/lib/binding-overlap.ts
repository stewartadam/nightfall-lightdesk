// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

export type UniverseKey = number | "*";

type UniverseOverlapFlags = { inputOverlap: boolean; outputOverlap: boolean };

export type BindingConflictColumn = "source" | "target";

type BindingEndpointReference = {
  rowId: string;
  column: BindingConflictColumn;
};

type UniverseTargetState = {
  wildcardOwners: BindingEndpointReference[];
  addressOwners: Map<number, BindingEndpointReference[]>;
};

type TransportTargetState = {
  inputWildcardOwners: BindingEndpointReference[];
  inputAddressOwners: Map<number, BindingEndpointReference[]>;
  outputWildcardOwners: BindingEndpointReference[];
  outputAddressOwners: Map<number, BindingEndpointReference[]>;
};

type FixtureTargetState = Map<string, BindingEndpointReference[]>;

export type BindingOverlapAnalysis = {
  universeIds: Set<number>;
  overlapByUniverse: Map<UniverseKey, UniverseOverlapFlags>;
  bindingUniverses: Map<string, Set<UniverseKey>>;
  conflictColumnsByBinding: Map<string, Set<BindingConflictColumn>>;
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
    case "Disabled":
      return [];
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

function markBindingConflictColumn(
  conflictColumnsByBinding: Map<string, Set<BindingConflictColumn>>,
  reference: BindingEndpointReference,
) {
  const columns = conflictColumnsByBinding.get(reference.rowId) ?? new Set();
  columns.add(reference.column);
  conflictColumnsByBinding.set(reference.rowId, columns);
}

function markBindingConflictColumns(
  conflictColumnsByBinding: Map<string, Set<BindingConflictColumn>>,
  references: BindingEndpointReference[],
) {
  for (const reference of references) {
    markBindingConflictColumn(conflictColumnsByBinding, reference);
  }
}

function allUniverseTargetOwners(
  entry: UniverseTargetState,
): BindingEndpointReference[] {
  return [
    ...entry.wildcardOwners,
    ...Array.from(entry.addressOwners.values()).flat(),
  ];
}

function registerUniverseTargetAddress(
  conflictColumnsByBinding: Map<string, Set<BindingConflictColumn>>,
  entry: UniverseTargetState,
  address: number | undefined,
  owner: BindingEndpointReference,
): BindingEndpointReference[] {
  const conflictingOwners =
    address === undefined
      ? allUniverseTargetOwners(entry)
      : [...entry.wildcardOwners, ...(entry.addressOwners.get(address) ?? [])];

  if (conflictingOwners.length > 0) {
    markBindingConflictColumns(conflictColumnsByBinding, conflictingOwners);
    markBindingConflictColumn(conflictColumnsByBinding, owner);
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
  conflictColumnsByBinding: Map<string, Set<BindingConflictColumn>>,
  inputTargets: Map<UniverseKey, UniverseTargetState>,
  universeKey: UniverseKey,
  address: number | undefined,
  owner: BindingEndpointReference,
) {
  const overlapFlags = ensureOverlapFlags(overlapsByUniverse, universeKey);
  const entry = inputTargets.get(universeKey) ?? {
    wildcardOwners: [],
    addressOwners: new Map<number, BindingEndpointReference[]>(),
  };
  const conflictingOwners = registerUniverseTargetAddress(
    conflictColumnsByBinding,
    entry,
    address,
    owner,
  );
  if (conflictingOwners.length > 0) overlapFlags.inputOverlap = true;

  inputTargets.set(universeKey, entry);
}

function registerFixtureInputTarget(
  conflictColumnsByBinding: Map<string, Set<BindingConflictColumn>>,
  fixtureTargets: FixtureTargetState,
  targetKey: string,
  owner: BindingEndpointReference,
) {
  const owners = fixtureTargets.get(targetKey) ?? [];
  if (owners.length > 0) {
    markBindingConflictColumns(conflictColumnsByBinding, owners);
    markBindingConflictColumn(conflictColumnsByBinding, owner);
  }

  owners.push(owner);
  fixtureTargets.set(targetKey, owners);
}

function registerOutputConsoleTarget(
  overlapsByUniverse: Map<UniverseKey, UniverseOverlapFlags>,
  conflictColumnsByBinding: Map<string, Set<BindingConflictColumn>>,
  outputConsoleTargets: Map<UniverseKey, UniverseTargetState>,
  universeKey: UniverseKey,
  address: number | undefined,
  owner: BindingEndpointReference,
) {
  const overlapFlags = ensureOverlapFlags(overlapsByUniverse, universeKey);
  const entry = outputConsoleTargets.get(universeKey) ?? {
    wildcardOwners: [],
    addressOwners: new Map<number, BindingEndpointReference[]>(),
  };
  const conflictingOwners = registerUniverseTargetAddress(
    conflictColumnsByBinding,
    entry,
    address,
    owner,
  );
  if (conflictingOwners.length > 0) overlapFlags.outputOverlap = true;

  outputConsoleTargets.set(universeKey, entry);
}

function registerOutputTransportBinding(
  overlapsByUniverse: Map<UniverseKey, UniverseOverlapFlags>,
  conflictColumnsByBinding: Map<string, Set<BindingConflictColumn>>,
  outputTransportStats: Map<
    UniverseKey,
    Map<
      string,
      {
        consoleOwners: BindingEndpointReference[];
        otherOwners: BindingEndpointReference[];
      }
    >
  >,
  universeKey: UniverseKey,
  transport: string,
  isConsoleSource: boolean,
  owner: BindingEndpointReference,
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
    markBindingConflictColumns(conflictColumnsByBinding, [
      ...stat.consoleOwners,
      ...stat.otherOwners,
    ]);
  }
}

function registerTransportTarget(
  overlapsByUniverse: Map<UniverseKey, UniverseOverlapFlags>,
  conflictColumnsByBinding: Map<string, Set<BindingConflictColumn>>,
  transportTargets: Map<string, TransportTargetState>,
  universeKey: UniverseKey,
  transport: string,
  address: number | undefined,
  direction: "input" | "output",
  owner: BindingEndpointReference,
) {
  const overlapFlags = ensureOverlapFlags(overlapsByUniverse, universeKey);
  const targetKey = `${transport}|${universeKey}`;
  const entry = transportTargets.get(targetKey) ?? {
    inputWildcardOwners: [],
    inputAddressOwners: new Map<number, BindingEndpointReference[]>(),
    outputWildcardOwners: [],
    outputAddressOwners: new Map<number, BindingEndpointReference[]>(),
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
    conflictColumnsByBinding,
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
    markBindingConflictColumns(conflictColumnsByBinding, [
      ...crossDirectionConflicts,
      owner,
    ]);
  }

  transportTargets.set(targetKey, entry);
}

export function computeBindingOverlapAnalysis(
  snapshot: types.BindingsSnapshot,
  activeUniverses: number[],
): BindingOverlapAnalysis {
  const universeIds = new Set<number>(activeUniverses);
  const overlapsByUniverse = new Map<UniverseKey, UniverseOverlapFlags>();
  const bindingUniverses = new Map<string, Set<UniverseKey>>();
  const conflictColumnsByBinding = new Map<
    string,
    Set<BindingConflictColumn>
  >();

  const inputTargets = new Map<UniverseKey, UniverseTargetState>();
  const fixtureInputTargets: FixtureTargetState = new Map();
  const outputConsoleTargets = new Map<UniverseKey, UniverseTargetState>();
  const transportTargets = new Map<string, TransportTargetState>();
  const outputTransportStats = new Map<
    UniverseKey,
    Map<
      string,
      {
        consoleOwners: BindingEndpointReference[];
        otherOwners: BindingEndpointReference[];
      }
    >
  >();

  for (const binding of snapshot.input) {
    addKnownUniverses(
      universeIds,
      collectUniversesFromInputSource(binding.source),
    );
    addKnownUniverses(
      universeIds,
      collectUniversesFromInputTarget(binding.target),
    );
  }
  for (const binding of snapshot.output) {
    addKnownUniverses(
      universeIds,
      collectUniversesFromOutputSource(binding.source),
    );
    addKnownUniverses(
      universeIds,
      collectUniversesFromOutputTarget(binding.target),
    );
  }
  for (const binding of snapshot.disabled) {
    if (binding.type === "Input") {
      addKnownUniverses(
        universeIds,
        collectUniversesFromInputSource(binding.data.source),
      );
    } else {
      addKnownUniverses(
        universeIds,
        collectUniversesFromOutputSource(binding.data.source),
      );
    }
  }

  snapshot.input.forEach((binding, index) => {
    const rowId = `input-${index}`;
    const keys = new Set<UniverseKey>([
      ...collectUniversesFromInputSource(binding.source),
      ...collectUniversesFromInputTarget(binding.target),
    ]);
    bindingUniverses.set(
      rowId,
      new Set(getExpandedUniversesForKeys(keys, universeIds)),
    );

    if (binding.target.type === "Console") {
      const targetUniverses = getExpandedUniversesForKeys(keys, universeIds);
      for (const universeKey of targetUniverses) {
        registerInputTarget(
          overlapsByUniverse,
          conflictColumnsByBinding,
          inputTargets,
          universeKey,
          binding.target.data.address ?? undefined,
          { rowId, column: "target" },
        );
      }
    }

    if (binding.target.type === "Transport") {
      const targetUniverses = getExpandedUniversesForKeys(keys, universeIds);
      for (const universeKey of targetUniverses) {
        registerTransportTarget(
          overlapsByUniverse,
          conflictColumnsByBinding,
          transportTargets,
          universeKey,
          binding.target.data.target,
          binding.target.data.address ?? undefined,
          "input",
          { rowId, column: "target" },
        );
      }
    }

    for (const targetKey of collectFixtureInputTargetKeys(binding.target)) {
      registerFixtureInputTarget(
        conflictColumnsByBinding,
        fixtureInputTargets,
        targetKey,
        { rowId, column: "source" },
      );
    }
  });

  snapshot.output.forEach((binding, index) => {
    const rowId = `output-${index}`;
    const keys = new Set<UniverseKey>([
      ...collectUniversesFromOutputSource(binding.source),
      ...collectUniversesFromOutputTarget(binding.target),
    ]);
    bindingUniverses.set(
      rowId,
      new Set(getExpandedUniversesForKeys(keys, universeIds)),
    );

    const targetUniverses = getExpandedUniversesForKeys(keys, universeIds);

    if (binding.target.type === "Console") {
      for (const universeKey of targetUniverses) {
        registerOutputConsoleTarget(
          overlapsByUniverse,
          conflictColumnsByBinding,
          outputConsoleTargets,
          universeKey,
          binding.target.data.address ?? undefined,
          { rowId, column: "target" },
        );
      }
    }

    if (binding.target.type === "Transport") {
      const isConsoleSource = binding.source.type === "Console";
      for (const universeKey of targetUniverses) {
        registerOutputTransportBinding(
          overlapsByUniverse,
          conflictColumnsByBinding,
          outputTransportStats,
          universeKey,
          binding.target.data.target,
          isConsoleSource,
          { rowId, column: "target" },
        );
        registerTransportTarget(
          overlapsByUniverse,
          conflictColumnsByBinding,
          transportTargets,
          universeKey,
          binding.target.data.target,
          binding.target.data.address ?? undefined,
          "output",
          { rowId, column: "target" },
        );
      }
    }
  });

  snapshot.disabled.forEach((binding, index) => {
    const rowId = `disabled-${index}`;
    const keys = new Set<UniverseKey>(
      binding.type === "Input"
        ? collectUniversesFromInputSource(binding.data.source)
        : collectUniversesFromOutputSource(binding.data.source),
    );
    bindingUniverses.set(
      rowId,
      new Set(getExpandedUniversesForKeys(keys, universeIds)),
    );

    const targetUniverses = getExpandedUniversesForKeys(keys, universeIds);

    if (binding.type === "Input") {
      if (binding.data.source.type === "Console") {
        for (const universeKey of targetUniverses) {
          registerInputTarget(
            overlapsByUniverse,
            conflictColumnsByBinding,
            inputTargets,
            universeKey,
            binding.data.source.data.address ?? undefined,
            { rowId, column: "source" },
          );
        }
      }
      return;
    }

    if (binding.data.source.type === "Console") {
      for (const universeKey of targetUniverses) {
        const overlapFlags = ensureOverlapFlags(
          overlapsByUniverse,
          universeKey,
        );
        overlapFlags.outputOverlap = true;
        markBindingConflictColumn(conflictColumnsByBinding, {
          rowId,
          column: "source",
        });
      }
    }
  });

  return {
    universeIds,
    overlapByUniverse: overlapsByUniverse,
    bindingUniverses,
    conflictColumnsByBinding,
  };
}
