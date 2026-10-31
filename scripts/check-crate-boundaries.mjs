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
const crateLayersPath = join(architectureConfigRoot, "crate-layers.json");
const ARCHITECTURAL_LAYERS = [
  "base",
  "engine-core",
  "plugins",
  "cross-plugin",
  "hosts",
];
const CRATE_LAYERS = loadCrateLayers();

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

/** Loads and validates architectural layer assignments for workspace crates. */
function loadCrateLayers() {
  const configuration = JSON.parse(readFileSync(crateLayersPath, "utf8"));
  return configuredCrateLayers(configuration);
}

/** Validates configured layer groups and returns a crate-to-layer lookup. */
export function configuredCrateLayers(configuration) {
  if (
    !configuration ||
    typeof configuration !== "object" ||
    !configuration.layers ||
    typeof configuration.layers !== "object" ||
    Array.isArray(configuration.layers)
  ) {
    throw new Error("crate layer configuration requires a layers object");
  }

  const configuredLayerNames = Object.keys(configuration.layers);
  const missingLayers = ARCHITECTURAL_LAYERS.filter(
    (layer) => !configuredLayerNames.includes(layer),
  );
  const unknownLayers = configuredLayerNames.filter(
    (layer) => !ARCHITECTURAL_LAYERS.includes(layer),
  );
  if (missingLayers.length > 0 || unknownLayers.length > 0) {
    throw new Error(
      `crate layer configuration has invalid layer groups (missing: ${missingLayers.join(", ") || "none"}; unknown: ${unknownLayers.join(", ") || "none"})`,
    );
  }

  const crateLayers = new Map();
  for (const layer of ARCHITECTURAL_LAYERS) {
    const packageNames = configuration.layers[layer];
    if (!Array.isArray(packageNames)) {
      throw new Error(`crate layer group must be an array: ${layer}`);
    }
    for (const packageName of packageNames) {
      if (
        typeof packageName !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packageName)
      ) {
        throw new Error(
          `crate layer group contains an invalid crate name: ${layer}`,
        );
      }
      const previousLayer = crateLayers.get(packageName);
      if (previousLayer) {
        throw new Error(
          `crate is assigned to multiple architectural layers: ${packageName} (${previousLayer}, ${layer})`,
        );
      }
      crateLayers.set(packageName, layer);
    }
  }
  return crateLayers;
}

/** Returns the configured architectural layer for a workspace crate. */
function crateLayer(packageName, crateLayers = CRATE_LAYERS) {
  return crateLayers.get(packageName) ?? null;
}

/** Fails if any workspace package lacks an explicit architectural layer. */
export function validateClassifications(metadata, crateLayers = CRATE_LAYERS) {
  const unclassified = metadata.packages
    .map((pkg) => pkg.name)
    .filter((packageName) => crateLayer(packageName, crateLayers) === null)
    .sort((left, right) => left.localeCompare(right));
  if (unclassified.length === 0) {
    return;
  }

  console.error("Unclassified workspace crates:");
  for (const packageName of unclassified) {
    console.error(`  ${packageName}`);
  }
  throw new Error(
    "crate-boundary layer classification is missing for one or more workspace crates",
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
export function violatedRule(fromLayer, toLayer) {
  if (fromLayer === "base" && toLayer !== "base") {
    return "base-crate-must-not-depend-on-runtime-crate";
  }
  if (
    fromLayer === "engine-core" &&
    ["plugins", "cross-plugin", "hosts"].includes(toLayer)
  ) {
    return "engine-core-crate-must-not-depend-on-plugin-or-higher";
  }
  if (fromLayer === "plugins" && toLayer === "plugins") {
    return "plugin-crate-must-not-depend-on-plugin-crate";
  }
  if (fromLayer === "plugins" && ["cross-plugin", "hosts"].includes(toLayer)) {
    return "plugin-crate-must-not-depend-on-cross-plugin-or-host";
  }
  if (fromLayer === "cross-plugin" && toLayer === "hosts") {
    return "cross-plugin-crate-must-not-depend-on-host-crate";
  }
  return null;
}

/** Extracts all currently forbidden local dependency edges from cargo metadata. */
export function forbiddenEdges(metadata, crateLayers = CRATE_LAYERS) {
  const packageNames = new Set(metadata.packages.map((pkg) => pkg.name));
  const edges = [];
  for (const pkg of metadata.packages) {
    const fromLayer = crateLayer(pkg.name, crateLayers);
    for (const dependency of pkg.dependencies) {
      if (dependency.kind !== null) {
        continue;
      }
      if (!isWorkspaceDependency(dependency, packageNames)) {
        continue;
      }
      const toLayer = crateLayer(dependency.name, crateLayers);
      const rule = violatedRule(fromLayer, toLayer);
      if (!rule) {
        continue;
      }
      edges.push({
        from: pkg.name,
        to: dependency.name,
        fromLayer,
        toLayer,
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
