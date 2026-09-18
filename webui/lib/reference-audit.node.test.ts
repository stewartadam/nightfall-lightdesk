// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import {
  AttributeCategory,
  FadeCurve,
  FlowPortType,
  FxDirection,
  InclusionMode,
  TrackingFlags,
} from "../types";
import {
  buildReferenceAudit,
  pruneMissingSelectionReferences,
} from "./reference-audit";

/** Creates stable identifiers for reference-audit fixtures and showfile objects. */
function identifiers(
  id: number,
  uid: string,
  label = `Object ${id}`,
): types.Identifiers {
  return { id, uid, label };
}

/** Creates a minimal fixture with the requested element count. */
function fixture(id: number, uid: string, elementCount = 1): types.Fixture {
  return {
    identifiers: identifiers(id, uid, `Fixture ${id}`),
    make: "Test",
    model: "Fixture",
    mode: "Default",
    elements: Array.from({ length: elementCount }, (_, index) => ({
      label: `Element ${index + 1}`,
      parameters: [],
    })),
  };
}

/** Creates a spatial selection resolved to explicit fixture refs. */
function resolvedSelection(refs: types.FixtureRef[]): types.SpatialSelection {
  return {
    source: { type: "Resolved", data: refs },
    clauses: [],
  };
}

/** Creates an empty cue suitable for audit tests. */
function cue(
  id: number,
  uid: string,
  selection: types.SpatialSelection,
): types.Cue {
  return {
    identifiers: identifiers(id, uid, `Cue ${id}`),
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [
      {
        selection,
        cue_instruction: {
          values: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
          transitions: {},
        },
      },
    ],
    parts: [],
    tracking_flags: TrackingFlags.HTP,
  };
}

/** Creates an immediate transition mode for sequence audit fixtures. */
function fixedZeroMode(): types.TransitionMode {
  return { type: "Fixed", data: { secs: 0, nanos: 0 } };
}

/** Creates a sequence containing caller-provided embedded setup and release cues. */
function sequence(
  id: number,
  uid: string,
  setupCue: types.Cue,
  releaseCue: types.Cue,
): types.Sequence {
  return {
    identifiers: identifiers(id, uid, `Sequence ${id}`),
    steps: [],
    wrap: false,
    release_on_start: false,
    setup_cue: setupCue,
    release_cue: releaseCue,
    default_timing: {
      delay_in: fixedZeroMode(),
      fade_in: fixedZeroMode(),
      curve_in: FadeCurve.Linear,
      delay_out: fixedZeroMode(),
      fade_out: fixedZeroMode(),
      curve_out: FadeCurve.Linear,
    },
    tracking_mode: { type: "Flags", data: TrackingFlags.HTP },
  };
}

/** Creates an FX definition with the provided spatial selection. */
function fx(
  id: number,
  uid: string,
  selection: types.SpatialSelection,
): types.Fx {
  return {
    identifiers: identifiers(id, uid, `FX ${id}`),
    selection,
    attributes: {},
  };
}

/** Creates a flow with one selection-valued port. */
function flow(
  id: number,
  uid: string,
  selection: types.SpatialSelection,
): types.FlowDefinition {
  return {
    identifiers: identifiers(id, uid, `Flow ${id}`),
    flow_version: 0,
    nodes: [
      {
        node_id: 1,
        kind: "constant-selection",
        label: "Selection",
        ports: [
          {
            port_id: 1,
            port_type: FlowPortType.Selection,
            default_value: { type: "Selection", data: selection },
          },
        ],
      },
    ],
    edges: [],
  };
}

/**
 * Verifies missing resolved fixture UIDs and out-of-range elements are audited.
 */
test("buildReferenceAudit reports missing resolved fixture references", () => {
  const audit = buildReferenceAudit({
    fixtures: {
      "fixture-one": fixture(1, "fixture-one", 1),
    },
    groups: {},
    cues: {
      "cue-one": cue(
        1,
        "cue-one",
        resolvedSelection([
          { fixture_uid: "fixture-one", index: 2 },
          { fixture_uid: "missing-fixture" },
        ]),
      ),
    },
    fx: {},
    stepFx: {},
    fxModules: {},
    flows: {},
  });

  assert.equal(audit.summary.issueCount, 2);
  assert.equal(audit.summary.prunableIssueCount, 2);
  assert.deepEqual(
    audit.issues.map((issue) => issue.reason),
    ["missing-fixture-element", "missing-fixture-uid"],
  );
});

/**
 * Verifies unresolved fixture and group expressions are surfaced but not pruned.
 */
test("buildReferenceAudit reports non-prunable unresolved selection issues", () => {
  const audit = buildReferenceAudit({
    fixtures: {
      "fixture-one": fixture(1, "fixture-one", 1),
    },
    groups: {},
    cues: {},
    fx: {
      "fx-one": fx(1, "fx-one", {
        source: { type: "Fixture", data: { fixture_id: 99 } },
        clauses: [],
      }),
      "fx-two": fx(2, "fx-two", {
        source: {
          type: "Fixture",
          data: { fixture_id: 1, element_index: 2 },
        },
        clauses: [],
      }),
    },
    stepFx: {},
    fxModules: {},
    flows: {},
  });

  assert.equal(audit.summary.issueCount, 2);
  assert.equal(audit.summary.prunableIssueCount, 0);
  assert.deepEqual(
    audit.issues.map((issue) => issue.reason),
    ["missing-fixture-id", "missing-fixture-element"],
  );
});

/**
 * Verifies fixture maps report both stale fixture IDs and invalid element indexes.
 */
test("buildReferenceAudit reports missing fixture map targets", () => {
  const audit = buildReferenceAudit({
    fixtures: {
      "fixture-one": fixture(1, "fixture-one", 1),
    },
    groups: {},
    cues: {},
    fx: {
      "fx-one": fx(1, "fx-one", {
        source: {
          type: "FixtureMap",
          data: {
            fixtures: { start: 1, end: 2 },
            elements: { type: "Range", data: { start: 1, end: 2 } },
          },
        },
        clauses: [],
      }),
    },
    stepFx: {},
    fxModules: {},
    flows: {},
  });

  assert.equal(audit.summary.referenceCount, 4);
  assert.equal(audit.references.length, 4);
  assert.equal(audit.summary.issueCount, 2);
  assert.deepEqual(
    audit.issues.map((issue) => issue.reason),
    ["missing-fixture-element", "missing-fixture-id"],
  );
});

/**
 * Verifies fixture ranges with element endpoints report missing elements.
 */
test("buildReferenceAudit reports missing fixture range element endpoints", () => {
  const audit = buildReferenceAudit({
    fixtures: {
      "fixture-one": fixture(1, "fixture-one", 1),
      "fixture-two": fixture(2, "fixture-two", 2),
    },
    groups: {},
    cues: {},
    fx: {
      "fx-one": fx(1, "fx-one", {
        source: {
          type: "FixtureRange",
          data: {
            start: { fixture_id: 1, element_index: 2 },
            end: { fixture_id: 2, element_index: 3 },
          },
        },
        clauses: [],
      }),
    },
    stepFx: {},
    fxModules: {},
    flows: {},
  });

  assert.equal(audit.summary.referenceCount, 4);
  assert.equal(audit.summary.issueCount, 2);
  assert.equal(audit.summary.prunableIssueCount, 0);
  assert.deepEqual(
    audit.issues.map((issue) => issue.targetLabel),
    ["Fixture 1.2", "Fixture 2.3"],
  );
  assert.deepEqual(
    audit.issues.map((issue) => issue.reason),
    ["missing-fixture-element", "missing-fixture-element"],
  );
});

/**
 * Verifies output patch bindings report missing Output transport target ids.
 */
test("buildReferenceAudit reports missing output transport target references", () => {
  const audit = buildReferenceAudit({
    fixtures: {},
    groups: {},
    cues: {},
    fx: {},
    stepFx: {},
    fxModules: {},
    flows: {},
    outputBindings: [
      {
        source: { type: "Console", data: {} },
        target: { type: "Transport", data: { target: "sacn" } },
        priority: 0,
        clone: false,
      },
      {
        source: { type: "Console", data: {} },
        target: { type: "Transport", data: { target: "removed-node" } },
        priority: 0,
        clone: false,
      },
    ],
  });

  assert.equal(audit.summary.objectCount, 2);
  assert.equal(audit.summary.referenceCount, 2);
  assert.equal(audit.summary.issueCount, 1);
  assert.equal(audit.summary.prunableIssueCount, 0);
  assert.deepEqual(
    audit.references.map((reference) => reference.status),
    ["missing", "ok"],
  );
  assert.deepEqual(audit.issues[0], {
    id: "patchBinding:output-binding-1:outputBindings[1].target.data.target:network-output-target:Output transport target removed-node:missing-network-output-target",
    source: {
      domain: "patchBinding",
      uid: "output-binding-1",
      id: 2,
      label: "Output binding 2",
      kindLabel: "Patch Binding",
    },
    path: "outputBindings[1].target.data.target",
    targetKind: "network-output-target",
    targetLabel: "Output transport target removed-node",
    reason: "missing-network-output-target",
    prunable: false,
  });
});

/**
 * Verifies pruning removes stale resolved refs from all supported object stores.
 */
test("pruneMissingSelectionReferences returns changed objects with stale refs removed", () => {
  const validRef = { fixture_uid: "fixture-one", index: 1 };
  const missingRef = { fixture_uid: "missing-fixture" };
  const sourceCue = cue(
    1,
    "cue-one",
    resolvedSelection([validRef, missingRef]),
  );
  Object.assign(sourceCue, { nonCloneableMarker: () => undefined });
  const pruned = pruneMissingSelectionReferences({
    fixtures: {
      "fixture-one": fixture(1, "fixture-one", 2),
    },
    groups: {
      "group-one": {
        identifiers: identifiers(1, "group-one", "Group 1"),
        selection: resolvedSelection([validRef, missingRef]),
        description: "",
      },
    },
    cues: {
      "cue-one": sourceCue,
    },
    fx: {},
    stepFx: {},
    fxModules: {},
    flows: {
      "flow-one": flow(
        1,
        "flow-one",
        resolvedSelection([validRef, missingRef]),
      ),
    },
  });

  assert.equal(pruned.prunedReferenceCount, 3);
  assert.equal(pruned.groups.length, 1);
  assert.equal(pruned.cues.length, 1);
  assert.equal(pruned.flows.length, 1);
  assert.deepEqual(
    pruned.groups[0]?.selection.source,
    resolvedSelection([validRef]).source,
  );
});

/**
 * Verifies pruning follows the same spatial union branches as reference auditing.
 */
test("pruneMissingSelectionReferences prunes spatial union branches", () => {
  const validRef = { fixture_uid: "fixture-one", index: 1 };
  const missingRef = { fixture_uid: "missing-fixture" };
  const missingElementRef = { fixture_uid: "fixture-one", index: 2 };
  const selection: types.SpatialSelection = {
    source: { type: "Resolved", data: [validRef] },
    clauses: [],
    union: [
      {
        source: { type: "Resolved", data: [missingRef, validRef] },
        clauses: [],
      },
      {
        source: {
          type: "Spatial",
          data: resolvedSelection([missingElementRef, validRef]),
        },
        clauses: [],
      },
    ],
  };

  const pruned = pruneMissingSelectionReferences({
    fixtures: {
      "fixture-one": fixture(1, "fixture-one", 1),
    },
    groups: {
      "group-one": {
        identifiers: identifiers(1, "group-one", "Group 1"),
        selection,
        description: "",
      },
    },
    cues: {},
    fx: {},
    stepFx: {},
    fxModules: {},
    flows: {},
  });

  assert.equal(pruned.prunedReferenceCount, 2);
  assert.equal(pruned.groups.length, 1);
  const prunedSelection = pruned.groups[0]?.selection;
  assert.deepEqual(
    prunedSelection?.source,
    resolvedSelection([validRef]).source,
  );
  assert.deepEqual(
    prunedSelection?.union?.[0]?.source,
    resolvedSelection([validRef]).source,
  );
  assert.equal(prunedSelection?.union?.[1]?.source.type, "Spatial");
  const nestedSelection =
    prunedSelection?.union?.[1]?.source.type === "Spatial"
      ? prunedSelection.union[1].source.data
      : undefined;
  assert.deepEqual(
    nestedSelection?.source,
    resolvedSelection([validRef]).source,
  );

  const auditAfterPrune = buildReferenceAudit({
    fixtures: {
      "fixture-one": fixture(1, "fixture-one", 1),
    },
    groups: Object.fromEntries(
      pruned.groups.map((group) => [group.identifiers.uid, group]),
    ),
    cues: {},
    fx: {},
    stepFx: {},
    fxModules: {},
    flows: {},
  });
  assert.equal(auditAfterPrune.summary.prunableIssueCount, 0);
});

test("buildReferenceAudit reports missing stable group references", () => {
  const audit = buildReferenceAudit({
    fixtures: {},
    groups: {
      "group-one": {
        identifiers: identifiers(1, "group-one", "Group 1"),
        selection: resolvedSelection([]),
        description: "",
      },
    },
    cues: {},
    fx: {
      "fx-one": fx(1, "fx-one", {
        source: {
          type: "Group",
          data: { type: "ByUid", data: { uid: "missing-group" } },
        },
        clauses: [],
      }),
      "fx-two": fx(2, "fx-two", {
        source: {
          type: "Group",
          data: { type: "MissingById", data: 2 },
        },
        clauses: [],
      }),
      "fx-three": fx(3, "fx-three", {
        source: {
          type: "Group",
          data: { type: "MissingByLabel", data: "Missing Group" },
        },
        clauses: [],
      }),
    },
    stepFx: {},
    fxModules: {},
    flows: {},
  });

  assert.equal(audit.summary.issueCount, 3);
  assert.deepEqual(audit.issues.map((issue) => issue.reason).sort(), [
    "missing-group-id",
    "missing-group-id",
    "missing-group-uid",
  ]);
  assert.deepEqual(
    audit.references.map((reference) => reference.targetLabel).sort(),
    ['Group "Missing Group"', "Group 2", "Group UID missing-group"],
  );
});

/** Verifies cue Blueprint UUIDs participate in showfile reference health reporting. */
test("buildReferenceAudit reports missing Blueprint references", () => {
  const referencedCue = cue(1, "cue-one", resolvedSelection([]));
  referencedCue.instructions[0].cue_instruction.blueprint_application = {
    blueprint_uid: "missing-blueprint",
    selector: { type: "Category", data: AttributeCategory.Color },
  };

  const audit = buildReferenceAudit({
    fixtures: {},
    groups: {},
    cues: { "cue-one": referencedCue },
    fx: {},
    stepFx: {},
    fxModules: {},
    flows: {},
    blueprints: {
      "present-blueprint": {
        identifiers: identifiers(5, "present-blueprint", "Present"),
        values: {},
        inclusion_settings: {
          inclusion_mode: InclusionMode.COPY,
          inclusion_filters: [],
          exclusion_filters: [],
        },
        references: { palettes: [], fx: [] },
      },
    },
  });

  assert.equal(audit.summary.referenceCount, 1);
  assert.equal(audit.summary.issueCount, 1);
  assert.equal(audit.issues[0]?.reason, "missing-blueprint-uid");
  assert.equal(audit.issues[0]?.prunable, false);
  assert.match(audit.issues[0]?.path ?? "", /blueprint_application/);
});

/** Verifies Step FX scalar Blueprint sources participate in reference health reporting. */
test("buildReferenceAudit reports Step FX Blueprint references", () => {
  const stepFx: types.StepFx = {
    identifiers: identifiers(2, "step-fx-two", "Referenced Step FX"),
    selection: resolvedSelection([]),
    timing: { beat_duration: { secs: 1, nanos: 0 } },
    phase: { waypoints: [0, 1] },
    direction: FxDirection.Forward,
    cycle_scale: { type: "Auto" },
    lanes: [
      {
        attribute: { type: "Red" },
        absolute: {
          steps: [
            {
              uid: "present-step",
              target: { type: "AbsolutePercent", data: { value: 0.5 } },
              blueprint_uid: "present-blueprint",
              width_beats: 1,
              transition: { start: 0, end: 1 },
              curve: { type: "Linear", data: {} },
            },
            {
              uid: "missing-step",
              target: { type: "AbsolutePercent", data: { value: 1 } },
              blueprint_uid: "missing-blueprint",
              width_beats: 1,
              transition: { start: 0, end: 1 },
              curve: { type: "Linear", data: {} },
            },
          ],
        },
      },
    ],
  };

  const audit = buildReferenceAudit({
    fixtures: {},
    groups: {},
    cues: {},
    fx: {},
    stepFx: { "step-fx-two": stepFx },
    fxModules: {},
    flows: {},
    blueprints: {
      "present-blueprint": {
        identifiers: identifiers(5, "present-blueprint", "Present"),
        values: {},
        inclusion_settings: {
          inclusion_mode: InclusionMode.COPY,
          inclusion_filters: [],
          exclusion_filters: [],
        },
        references: { palettes: [], fx: [] },
      },
    },
  });

  assert.equal(audit.summary.referenceCount, 2);
  assert.equal(audit.summary.issueCount, 1);
  assert.equal(audit.issues[0]?.source.domain, "stepFx");
  assert.equal(audit.issues[0]?.reason, "missing-blueprint-uid");
});

/** Verifies embedded sequence cues participate in Blueprint reference health reporting. */
test("buildReferenceAudit reports missing Blueprint references in sequence meta cues", () => {
  const setupCue = cue(0, "sequence-setup", resolvedSelection([]));
  setupCue.instructions[0].cue_instruction.blueprint_application = {
    blueprint_uid: "missing-blueprint",
    selector: { type: "Category", data: AttributeCategory.Color },
  };
  const releaseCue = cue(0, "sequence-release", resolvedSelection([]));

  const audit = buildReferenceAudit({
    fixtures: {},
    groups: {},
    cues: {},
    sequences: {
      "sequence-one": sequence(1, "sequence-one", setupCue, releaseCue),
    },
    fx: {},
    stepFx: {},
    fxModules: {},
    flows: {},
    blueprints: {},
  });

  assert.equal(audit.summary.objectCount, 1);
  assert.equal(audit.summary.referenceCount, 1);
  assert.equal(audit.summary.issueCount, 1);
  assert.equal(audit.issues[0]?.source.domain, "sequence");
  assert.match(audit.issues[0]?.path ?? "", /^setup_cue\./);
});
