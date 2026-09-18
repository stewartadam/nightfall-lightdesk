#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const architectureConfigRoot = join(repoRoot, "config", "architecture");
const exceptionsPath = join(
  architectureConfigRoot,
  "crate-boundary-exceptions.json",
);
const crateRolesPath = join(architectureConfigRoot, "crate-roles.json");
const ARCHITECTURAL_ROLES = [
  "foundation",
  "infrastructure",
  "domain",
  "integration",
  "composition",
];
const CRATE_ROLES = loadCrateRoles();

/** Runs cargo metadata and returns parsed workspace package data. */
function cargoMetadata() {
  const result = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error("cargo metadata failed");
  }
  return JSON.parse(result.stdout);
}

/** Loads and validates architectural role assignments for workspace crates. */
function loadCrateRoles() {
  const configuration = JSON.parse(readFileSync(crateRolesPath, "utf8"));
  return configuredCrateRoles(configuration);
}

/** Validates configured role groups and returns a crate-to-role lookup. */
export function configuredCrateRoles(configuration) {
  if (
    !configuration ||
    typeof configuration !== "object" ||
    !configuration.roles ||
    typeof configuration.roles !== "object" ||
    Array.isArray(configuration.roles)
  ) {
    throw new Error("crate role configuration requires a roles object");
  }

  const configuredRoleNames = Object.keys(configuration.roles);
  const missingRoles = ARCHITECTURAL_ROLES.filter(
    (role) => !configuredRoleNames.includes(role),
  );
  const unknownRoles = configuredRoleNames.filter(
    (role) => !ARCHITECTURAL_ROLES.includes(role),
  );
  if (missingRoles.length > 0 || unknownRoles.length > 0) {
    throw new Error(
      `crate role configuration has invalid role groups (missing: ${missingRoles.join(", ") || "none"}; unknown: ${unknownRoles.join(", ") || "none"})`,
    );
  }

  const crateRoles = new Map();
  for (const role of ARCHITECTURAL_ROLES) {
    const packageNames = configuration.roles[role];
    if (!Array.isArray(packageNames)) {
      throw new Error(`crate role group must be an array: ${role}`);
    }
    for (const packageName of packageNames) {
      if (
        typeof packageName !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packageName)
      ) {
        throw new Error(
          `crate role group contains an invalid crate name: ${role}`,
        );
      }
      const previousRole = crateRoles.get(packageName);
      if (previousRole) {
        throw new Error(
          `crate is assigned to multiple architectural roles: ${packageName} (${previousRole}, ${role})`,
        );
      }
      crateRoles.set(packageName, role);
    }
  }
  return crateRoles;
}

/** Returns the configured architectural role for a workspace crate. */
function crateRole(packageName, crateRoles = CRATE_ROLES) {
  return crateRoles.get(packageName) ?? null;
}

/** Fails if any workspace package lacks an explicit architectural role. */
export function validateClassifications(metadata, crateRoles = CRATE_ROLES) {
  const unclassified = metadata.packages
    .map((pkg) => pkg.name)
    .filter((packageName) => crateRole(packageName, crateRoles) === null)
    .sort((left, right) => left.localeCompare(right));
  if (unclassified.length === 0) {
    return;
  }

  console.error("Unclassified workspace crates:");
  for (const packageName of unclassified) {
    console.error(`  ${packageName}`);
  }
  throw new Error(
    "crate-boundary role classification is missing for one or more workspace crates",
  );
}

/** Returns true when a cargo dependency points at a local workspace package. */
function isWorkspaceDependency(dependency, packageNames) {
  return dependency.source === null && packageNames.has(dependency.name);
}

/** Returns a stable key for a forbidden local dependency edge. */
function edgeKey(edge) {
  return `${edge.from}->${edge.to}:${edge.rule}`;
}

/** Describes the boundary rule violated by a local dependency edge, if any. */
export function violatedRule(fromRole, toRole) {
  if (fromRole === "foundation" && toRole !== "foundation") {
    return "foundation-crate-must-not-depend-on-runtime-crate";
  }
  if (
    fromRole === "infrastructure" &&
    ["domain", "integration", "composition"].includes(toRole)
  ) {
    return "infrastructure-crate-must-not-depend-on-domain-or-higher";
  }
  if (fromRole === "domain" && toRole === "domain") {
    return "domain-crate-must-not-depend-on-domain-crate";
  }
  if (
    fromRole === "domain" &&
    ["integration", "composition"].includes(toRole)
  ) {
    return "domain-crate-must-not-depend-on-integration-or-composition";
  }
  if (fromRole === "integration" && toRole === "composition") {
    return "integration-crate-must-not-depend-on-composition-crate";
  }
  return null;
}

/** Extracts all currently forbidden local dependency edges from cargo metadata. */
export function forbiddenEdges(metadata, crateRoles = CRATE_ROLES) {
  const packageNames = new Set(metadata.packages.map((pkg) => pkg.name));
  const edges = [];
  for (const pkg of metadata.packages) {
    const fromRole = crateRole(pkg.name, crateRoles);
    for (const dependency of pkg.dependencies) {
      if (dependency.kind !== null) {
        continue;
      }
      if (!isWorkspaceDependency(dependency, packageNames)) {
        continue;
      }
      const toRole = crateRole(dependency.name, crateRoles);
      const rule = violatedRule(fromRole, toRole);
      if (!rule) {
        continue;
      }
      edges.push({
        from: pkg.name,
        to: dependency.name,
        fromRole,
        toRole,
        rule,
      });
    }
  }
  return edges.sort((left, right) =>
    edgeKey(left).localeCompare(edgeKey(right)),
  );
}

/** Rejects normal dependency paths from DMX input adapters into routing or UI implementation. */
export function validateInputAdapterIsolation(metadata) {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.name, pkg]));
  const forbidden = new Set([
    "nightfall-fixtures",
    "nightfall-compositor",
    "nightfall-desk",
  ]);
  for (const adapter of ["nightfall-input-artnet", "nightfall-input-sacn"]) {
    const pending = [[adapter]];
    const visited = new Set();
    while (pending.length > 0) {
      const path = pending.pop();
      const name = path.at(-1);
      if (forbidden.has(name)) {
        throw new Error(
          `input adapter isolation violated: ${path.join(" -> ")}`,
        );
      }
      if (visited.has(name)) continue;
      visited.add(name);
      for (const dependency of packages.get(name)?.dependencies ?? []) {
        if (
          dependency.kind === null &&
          dependency.source === null &&
          packages.has(dependency.name)
        ) {
          pending.push([...path, dependency.name]);
        }
      }
    }
  }
}

/** Loads the curated set of explicitly allowed boundary violations. */
function loadExceptions() {
  const configuration = JSON.parse(readFileSync(exceptionsPath, "utf8"));
  return configuredExceptionEdges(configuration);
}

/** Flattens and validates curated architectural exception groups. */
export function configuredExceptionEdges(configuration) {
  if (!Array.isArray(configuration.exceptions)) {
    throw new Error(
      "crate-boundary exception configuration requires an exceptions array",
    );
  }

  const edges = [];
  const exceptionIds = new Set();
  const edgeKeys = new Set();
  for (const exception of configuration.exceptions) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(exception.id)) {
      throw new Error(
        "crate-boundary exceptions require a stable lowercase kebab-case ID",
      );
    }
    if (exceptionIds.has(exception.id)) {
      throw new Error(`duplicate crate-boundary exception ID: ${exception.id}`);
    }
    exceptionIds.add(exception.id);
    if (typeof exception.reason !== "string" || !exception.reason.trim()) {
      throw new Error("crate-boundary exceptions require a reason");
    }
    if (!Array.isArray(exception.edges) || exception.edges.length === 0) {
      throw new Error("crate-boundary exceptions require at least one edge");
    }
    for (const edge of exception.edges) {
      const key = edgeKey(edge);
      if (edgeKeys.has(key)) {
        throw new Error(`duplicate crate-boundary exception edge: ${key}`);
      }
      edgeKeys.add(key);
      edges.push({
        ...edge,
        exceptionId: exception.id,
        exceptionReason: exception.reason,
      });
    }
  }
  return edges;
}

/** Returns new and stale forbidden edges relative to the curated exceptions. */
export function exceptionDiff(currentEdges, exceptionEdges) {
  const exceptionKeys = new Set(exceptionEdges.map(edgeKey));
  const currentKeys = new Set(currentEdges.map(edgeKey));
  return {
    newEdges: currentEdges.filter((edge) => !exceptionKeys.has(edgeKey(edge))),
    staleEdges: exceptionEdges.filter(
      (edge) => !currentKeys.has(edgeKey(edge)),
    ),
  };
}

/** Prints a compact table of dependency edges. */
function printEdges(label, edges) {
  if (edges.length === 0) {
    console.log(`${label}: none`);
    return;
  }
  console.log(`${label}:`);
  for (const edge of edges) {
    console.log(`  ${edge.from} -> ${edge.to} (${edge.rule})`);
  }
}

/** Runs the boundary check against the curated architecture exceptions. */
function main() {
  const metadata = cargoMetadata();
  validateClassifications(metadata);
  validateInputAdapterIsolation(metadata);
  const currentEdges = forbiddenEdges(metadata);
  const exceptionEdges = loadExceptions();
  const { newEdges, staleEdges } = exceptionDiff(currentEdges, exceptionEdges);
  const exceptionKeys = new Set(exceptionEdges.map(edgeKey));

  printEdges(
    "Allowed crate-boundary exceptions",
    currentEdges.filter((edge) => exceptionKeys.has(edgeKey(edge))),
  );
  printEdges("New crate-boundary violations", newEdges);
  printEdges("Stale crate-boundary exceptions", staleEdges);

  if (newEdges.length > 0 || staleEdges.length > 0) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main();
}
