// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  configuredCrateRoles,
  configuredExceptionEdges,
  exceptionDiff,
  forbiddenEdges,
  validateClassifications,
  validateInputAdapterIsolation,
  violatedRule,
} from "./check-crate-boundaries.mjs";

/** Builds a complete crate-role configuration for validation tests. */
function roleConfiguration(overrides = {}) {
  return {
    roles: {
      foundation: [],
      infrastructure: [],
      domain: [],
      integration: [],
      composition: [],
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

/** Verifies upward and cross-domain normal edges are rejected. */
test("forbiddenEdges rejects domain coupling and upward dependencies", () => {
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
        rule: "domain-crate-must-not-depend-on-integration-or-composition",
      },
      {
        from: "nightfall-cues",
        to: "nightfall-fx",
        rule: "domain-crate-must-not-depend-on-domain-crate",
      },
    ],
  );
});

/** Verifies each layer rejects dependencies that point across its upper boundary. */
test("violatedRule enforces the complete layer ordering", () => {
  assert.deepEqual(
    [
      ["foundation", "infrastructure"],
      ["infrastructure", "domain"],
      ["domain", "domain"],
      ["domain", "integration"],
      ["integration", "composition"],
      ["foundation", "foundation"],
      ["infrastructure", "infrastructure"],
      ["integration", "domain"],
      ["composition", "domain"],
    ].map(([fromRole, toRole]) => violatedRule(fromRole, toRole)),
    [
      "foundation-crate-must-not-depend-on-runtime-crate",
      "infrastructure-crate-must-not-depend-on-domain-or-higher",
      "domain-crate-must-not-depend-on-domain-crate",
      "domain-crate-must-not-depend-on-integration-or-composition",
      "integration-crate-must-not-depend-on-composition-crate",
      null,
      null,
      null,
      null,
    ],
  );
});

/** Verifies every workspace package must have an intentional role. */
test("validateClassifications rejects unclassified workspace crates", () => {
  assert.throws(
    () => validateClassifications({ packages: [pkg("nightfall-new-domain")] }),
    /role classification is missing/,
  );
});

/** Verifies crate-role configuration is complete and unambiguous. */
test("configuredCrateRoles validates architectural role assignments", () => {
  assert.equal(
    configuredCrateRoles(
      roleConfiguration({ domain: ["nightfall-example"] }),
    ).get("nightfall-example"),
    "domain",
  );
  assert.throws(
    () => configuredCrateRoles({ roles: { foundation: [] } }),
    /invalid role groups/,
  );
  assert.throws(
    () =>
      configuredCrateRoles(
        roleConfiguration({
          foundation: ["nightfall-example"],
          domain: ["nightfall-example"],
        }),
      ),
    /assigned to multiple architectural roles/,
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
