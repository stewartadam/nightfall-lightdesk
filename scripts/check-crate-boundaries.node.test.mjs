// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  configuredCrateLayers,
  configuredExceptionEdges,
  exceptionDiff,
  forbiddenEdges,
  validateClassifications,
  validateInputAdapterIsolation,
  violatedRule,
} from "./check-crate-boundaries.mjs";

/** Builds a complete crate-layer configuration for validation tests. */
function layerConfiguration(overrides = {}) {
  return {
    layers: {
      base: [],
      "engine-core": [],
      plugins: [],
      "cross-plugin": [],
      hosts: [],
      ...overrides,
    },
  };
}

/** Builds one local Cargo metadata dependency for boundary tests. */
function dependency(name, kind = null) {
  return { kind, name, source: null };
}

/** Builds one Cargo metadata package record for boundary tests. */
function pkg(name, dependencies = []) {
  return { dependencies, name };
}

/** Verifies upward and plugin-to-plugin normal edges are rejected. */
test("forbiddenEdges rejects plugin coupling and upward dependencies", () => {
  const metadata = {
    packages: [
      pkg("nightfall-cues", [
        dependency("nightfall-compositor"),
        dependency("nightfall-desk"),
        dependency("nightfall-fx"),
        dependency("nightfall-fx", "dev"),
      ]),
      pkg("nightfall-compositor"),
      pkg("nightfall-desk"),
      pkg("nightfall-fx"),
    ],
  };

  assert.deepEqual(
    forbiddenEdges(metadata).map(({ from, to, rule }) => ({
      from,
      to,
      rule,
    })),
    [
      {
        from: "nightfall-cues",
        to: "nightfall-desk",
        rule: "plugin-crate-must-not-depend-on-cross-plugin-or-host",
      },
      {
        from: "nightfall-cues",
        to: "nightfall-fx",
        rule: "plugin-crate-must-not-depend-on-plugin-crate",
      },
    ],
  );
});

/** Verifies each layer rejects dependencies that point across its upper boundary. */
test("violatedRule enforces the complete layer ordering", () => {
  assert.deepEqual(
    [
      ["base", "engine-core"],
      ["engine-core", "plugins"],
      ["plugins", "plugins"],
      ["plugins", "cross-plugin"],
      ["cross-plugin", "hosts"],
      ["base", "base"],
      ["engine-core", "engine-core"],
      ["cross-plugin", "plugins"],
      ["hosts", "plugins"],
    ].map(([fromLayer, toLayer]) => violatedRule(fromLayer, toLayer)),
    [
      "base-crate-must-not-depend-on-runtime-crate",
      "engine-core-crate-must-not-depend-on-plugin-or-higher",
      "plugin-crate-must-not-depend-on-plugin-crate",
      "plugin-crate-must-not-depend-on-cross-plugin-or-host",
      "cross-plugin-crate-must-not-depend-on-host-crate",
      null,
      null,
      null,
      null,
    ],
  );
});

/** Verifies every workspace package must have an intentional layer. */
test("validateClassifications rejects unclassified workspace crates", () => {
  assert.throws(
    () => validateClassifications({ packages: [pkg("nightfall-new-plugin")] }),
    /layer classification is missing/,
  );
});

/** Verifies crate-layer configuration is complete and unambiguous. */
test("configuredCrateLayers validates architectural layer assignments", () => {
  assert.equal(
    configuredCrateLayers(
      layerConfiguration({ plugins: ["nightfall-example"] }),
    ).get("nightfall-example"),
    "plugins",
  );
  assert.throws(
    () => configuredCrateLayers({ layers: { base: [] } }),
    /invalid layer groups/,
  );
  assert.throws(
    () =>
      configuredCrateLayers(
        layerConfiguration({
          base: ["nightfall-example"],
          plugins: ["nightfall-example"],
        }),
      ),
    /assigned to multiple architectural layers/,
  );
});

/** Verifies exception drift reports both newly added and removed edges. */
test("exceptionDiff reports new and stale exceptions", () => {
  const retained = { from: "a", to: "b", rule: "rule" };
  const added = { from: "a", to: "c", rule: "rule" };
  const removed = { from: "a", to: "d", rule: "rule" };

  assert.deepEqual(exceptionDiff([retained, added], [retained, removed]), {
    newEdges: [added],
    staleEdges: [removed],
  });
});

/** Verifies exception groups require stable descriptive identifiers. */
test("configuredExceptionEdges requires a stable exception ID", () => {
  assert.throws(
    () => configuredExceptionEdges({}),
    /requires an exceptions array/,
  );

  assert.throws(
    () =>
      configuredExceptionEdges({
        exceptions: [{ id: "Temporary Fix", reason: "Unassigned", edges: [] }],
      }),
    /stable lowercase kebab-case ID/,
  );

  assert.deepEqual(
    configuredExceptionEdges({
      exceptions: [
        {
          id: "clip-desk-integration",
          reason: "Clip contracts still live in desk.",
          edges: [
            { from: "nightfall-cues", to: "nightfall-desk", rule: "rule" },
          ],
        },
      ],
    }),
    [
      {
        from: "nightfall-cues",
        to: "nightfall-desk",
        rule: "rule",
        exceptionId: "clip-desk-integration",
        exceptionReason: "Clip contracts still live in desk.",
      },
    ],
  );
});

/** Verifies duplicate exception identities and edges are rejected. */
test("configuredExceptionEdges rejects duplicate configuration", () => {
  const edge = { from: "nightfall-cues", to: "nightfall-desk", rule: "rule" };
  assert.throws(
    () =>
      configuredExceptionEdges({
        exceptions: [
          { id: "desk-coupling", reason: "First", edges: [edge] },
          { id: "desk-coupling", reason: "Second", edges: [edge] },
        ],
      }),
    /duplicate crate-boundary exception ID/,
  );

  assert.throws(
    () =>
      configuredExceptionEdges({
        exceptions: [
          { id: "first-coupling", reason: "First", edges: [edge] },
          { id: "second-coupling", reason: "Second", edges: [edge] },
        ],
      }),
    /duplicate crate-boundary exception edge/,
  );
});

/** Verifies adapter isolation catches indirect routing dependencies through shared crates. */
test("input adapters cannot reach fixture runtime through another crate", () => {
  assert.throws(
    () =>
      validateInputAdapterIsolation({
        packages: [
          pkg("nightfall-input-artnet", [dependency("nightfall-io")]),
          pkg("nightfall-io", [dependency("nightfall-fixtures")]),
          pkg("nightfall-fixtures"),
        ],
      }),
    /nightfall-input-artnet -> nightfall-io -> nightfall-fixtures/,
  );
});

/** Allows adapter integration tests to exercise routing without adding production dependencies. */
test("input adapter isolation ignores dev dependencies and accepts shared contracts", () => {
  assert.doesNotThrow(() =>
    validateInputAdapterIsolation({
      packages: [
        pkg("nightfall-input-sacn", [
          dependency("nightfall-fixtures", "dev"),
          dependency("nightfall-io"),
        ]),
        pkg("nightfall-io", [dependency("nightfall-dmx")]),
        pkg("nightfall-dmx"),
        pkg("nightfall-fixtures"),
      ],
    }),
  );
});
