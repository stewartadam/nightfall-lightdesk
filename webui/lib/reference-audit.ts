// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import {
  defaultNetworkDmxOutputs,
  defaultUsbDmxOutputs,
  outputTransportForOutputTargetId,
} from "./network-dmx-output-targets";

export type ReferenceAuditDomain =
  | "group"
  | "cue"
  | "sequence"
  | "fx"
  | "stepFx"
  | "fxModule"
  | "flow"
  | "patchBinding";

type ReferenceTargetKind =
  | "fixture"
  | "group"
  | "blueprint"
  | "network-output-target";

export type ReferenceIssueReason =
  | "missing-fixture-uid"
  | "missing-fixture-id"
  | "missing-fixture-element"
  | "missing-group-uid"
  | "missing-group-id"
  | "missing-blueprint-uid"
  | "missing-network-output-target";

interface ReferenceAuditObject {
  domain: ReferenceAuditDomain;
  uid: string;
  id: number;
  label: string;
  kindLabel: string;
}

export interface ReferenceIssue {
  id: string;
  source: ReferenceAuditObject;
  path: string;
  targetKind: ReferenceTargetKind;
  targetLabel: string;
  reason: ReferenceIssueReason;
  prunable: boolean;
}

export interface ReferenceEntry {
  id: string;
  source: ReferenceAuditObject;
  path: string;
  targetKind: ReferenceTargetKind;
  targetLabel: string;
  status: "ok" | "missing";
}

interface ReferenceAuditSummary {
  objectCount: number;
  referenceCount: number;
  issueCount: number;
  prunableIssueCount: number;
  affectedObjectCount: number;
}

export interface ReferenceAuditResult {
  summary: ReferenceAuditSummary;
  references: ReferenceEntry[];
  issues: ReferenceIssue[];
}

export interface ReferenceAuditInputs {
  fixtures: Record<string, types.Fixture>;
  groups: Record<string, types.Group>;
  cues: Record<string, types.Cue>;
  sequences?: Record<string, types.Sequence>;
  fx: Record<string, types.Fx>;
  stepFx: Record<string, types.StepFx>;
  fxModules: Record<string, types.StoredFxModule>;
  flows: Record<string, types.FlowDefinition>;
  blueprints?: Record<string, types.Blueprint>;
  outputBindings?: types.OutputBinding[];
  networkDmxOutputs?: types.NetworkDmxOutputTargets;
  usbDmxOutputs?: types.UsbDmxOutputTargets;
}

export interface ReferencePruneResult {
  groups: types.Group[];
  cues: types.Cue[];
  fx: types.Fx[];
  stepFx: types.StepFx[];
  fxModules: types.StoredFxModule[];
  flows: types.FlowDefinition[];
  prunedReferenceCount: number;
}

interface FixtureIndex {
  fixtureIds: Set<number>;
  groupByUid: Map<string, types.Group>;
  groupById: Map<number, types.Group>;
  groupByLabel: Map<string, types.Group>;
  fixtureByUid: Map<string, types.Fixture>;
  fixtureById: Map<number, types.Fixture>;
}

interface SelectionAuditContext {
  source: ReferenceAuditObject;
  path: string;
  fixtures: FixtureIndex;
}

interface SelectionAuditResult {
  references: ReferenceEntry[];
  issues: ReferenceIssue[];
  referenceCount: number;
}

interface SelectionPruneResult {
  selection: types.SpatialSelection;
  changed: boolean;
  prunedReferenceCount: number;
}

interface FixtureRangeTarget {
  fixtureId: number;
  elementIndex?: number;
}

/** Builds a stable audit report for missing selection references in showfile stores. */
export function buildReferenceAudit(
  inputs: ReferenceAuditInputs,
): ReferenceAuditResult {
  const fixtureIndex = buildFixtureIndex(inputs.fixtures, inputs.groups);
  const networkDmxOutputs =
    inputs.networkDmxOutputs ?? defaultNetworkDmxOutputs();
  const usbDmxOutputs = inputs.usbDmxOutputs ?? defaultUsbDmxOutputs();
  const outputBindings = inputs.outputBindings ?? [];
  const issues: ReferenceIssue[] = [];
  const references: ReferenceEntry[] = [];
  let referenceCount = 0;
  const blueprintUids = new Set(Object.keys(inputs.blueprints ?? {}));
  const sequences = inputs.sequences ?? {};

  /** Audits one spatial selection and tracks the references it contains. */
  const auditSelection = (
    source: ReferenceAuditObject,
    selection: types.SpatialSelection,
    path: string,
  ) => {
    const result = auditSpatialSelection(selection, {
      source,
      path,
      fixtures: fixtureIndex,
    });
    referenceCount += result.referenceCount;
    references.push(...result.references);
    issues.push(...result.issues);
  };

  /** Audits one output binding target identifier against configured output targets. */
  const auditOutputBindingTarget = (
    binding: types.OutputBinding,
    index: number,
  ) => {
    if (binding.target.type !== "Transport") return;

    const targetId = binding.target.data.target;
    const source = outputBindingObject(index);
    const path = `outputBindings[${index}].target.data.target`;
    const targetLabel = `Output transport target ${targetId}`;
    const status = outputTransportForOutputTargetId(
      targetId,
      networkDmxOutputs,
      usbDmxOutputs,
    )
      ? "ok"
      : "missing";
    const context: SelectionAuditContext = {
      source,
      path,
      fixtures: fixtureIndex,
    };

    referenceCount += 1;
    references.push(
      referenceEntry(
        context,
        path,
        "network-output-target",
        targetLabel,
        status,
      ),
    );

    if (status === "missing") {
      issues.push(
        referenceIssue(
          context,
          path,
          "network-output-target",
          targetLabel,
          "missing-network-output-target",
          false,
        ),
      );
    }
  };

  /** Audits one stable Blueprint UUID retained by an authored object. */
  const auditBlueprintUid = (
    source: ReferenceAuditObject,
    blueprintUid: string,
    path: string,
  ) => {
    const targetLabel = `Blueprint ${blueprintUid}`;
    const status = blueprintUids.has(blueprintUid) ? "ok" : "missing";
    const context: SelectionAuditContext = {
      source,
      path,
      fixtures: fixtureIndex,
    };
    referenceCount += 1;
    references.push(
      referenceEntry(context, path, "blueprint", targetLabel, status),
    );
    if (status === "missing") {
      issues.push(
        referenceIssue(
          context,
          path,
          "blueprint",
          targetLabel,
          "missing-blueprint-uid",
          false,
        ),
      );
    }
  };

  /** Audits one optional live Blueprint application retained by a cue instruction. */
  const auditBlueprintApplication = (
    source: ReferenceAuditObject,
    application: types.BlueprintApplication | undefined,
    path: string,
  ) => {
    if (!application) return;
    auditBlueprintUid(source, application.blueprint_uid, path);
  };

  /** Audits fixture and Blueprint references owned by one cue-shaped container. */
  const auditCue = (
    source: ReferenceAuditObject,
    cue: types.Cue,
    pathPrefix = "",
  ) => {
    cue.instructions.forEach((instruction, index) => {
      auditSelection(
        source,
        instruction.selection,
        `${pathPrefix}instructions[${index}].selection.source`,
      );
      auditBlueprintApplication(
        source,
        instruction.cue_instruction.blueprint_application,
        `${pathPrefix}instructions[${index}].cue_instruction.blueprint_application.blueprint_uid`,
      );
    });
    (cue.parts ?? []).forEach((part, partIndex) => {
      part.instructions.forEach((instruction, instructionIndex) => {
        auditSelection(
          source,
          instruction.selection,
          `${pathPrefix}parts[${partIndex}].instructions[${instructionIndex}].selection.source`,
        );
        auditBlueprintApplication(
          source,
          instruction.cue_instruction.blueprint_application,
          `${pathPrefix}parts[${partIndex}].instructions[${instructionIndex}].cue_instruction.blueprint_application.blueprint_uid`,
        );
      });
    });
  };

  for (const group of Object.values(inputs.groups)) {
    auditSelection(groupObject(group), group.selection, "selection.source");
  }

  for (const cue of Object.values(inputs.cues)) {
    auditCue(cueObject(cue), cue);
  }

  for (const sequence of Object.values(sequences)) {
    const source = sequenceObject(sequence);
    auditCue(source, sequence.setup_cue, "setup_cue.");
    auditCue(source, sequence.release_cue, "release_cue.");
  }

  for (const fx of Object.values(inputs.fx)) {
    auditSelection(fxObject(fx), fx.selection, "selection.source");
  }

  for (const stepFx of Object.values(inputs.stepFx)) {
    const source = stepFxObject(stepFx);
    auditSelection(source, stepFx.selection, "selection.source");
    stepFx.lanes.forEach((lane, laneIndex) => {
      for (const trackName of ["absolute", "relative"] as const) {
        lane[trackName]?.steps.forEach((step, stepIndex) => {
          if (!step.blueprint_uid) return;
          auditBlueprintUid(
            source,
            step.blueprint_uid,
            `lanes[${laneIndex}].${trackName}.steps[${stepIndex}].blueprint_uid`,
          );
        });
      }
    });
  }

  for (const fxModule of Object.values(inputs.fxModules)) {
    auditSelection(
      fxModuleObject(fxModule),
      fxModule.selection,
      "selection.source",
    );
  }

  for (const flow of Object.values(inputs.flows)) {
    const source = flowObject(flow);
    flow.nodes.forEach((node) => {
      node.ports.forEach((port) => {
        if (port.default_value?.type !== "Selection") return;
        auditSelection(
          source,
          port.default_value.data,
          `nodes[${node.node_id}].ports[${port.port_id}].default_value`,
        );
      });
    });
  }

  outputBindings.forEach(auditOutputBindingTarget);

  const affectedObjectCount = new Set(
    issues.map((issue) => `${issue.source.domain}:${issue.source.uid}`),
  ).size;

  return {
    summary: {
      objectCount:
        Object.keys(inputs.groups).length +
        Object.keys(inputs.cues).length +
        Object.keys(sequences).length +
        Object.keys(inputs.fx).length +
        Object.keys(inputs.stepFx).length +
        Object.keys(inputs.fxModules).length +
        Object.keys(inputs.flows).length +
        outputBindings.length,
      referenceCount,
      issueCount: issues.length,
      prunableIssueCount: issues.filter((issue) => issue.prunable).length,
      affectedObjectCount,
    },
    references: references.sort(compareReferenceEntries),
    issues: issues.sort(compareReferenceIssues),
  };
}

/** Prunes missing resolved fixture references from mutable showfile definitions. */
export function pruneMissingSelectionReferences(
  inputs: ReferenceAuditInputs,
): ReferencePruneResult {
  const fixtureIndex = buildFixtureIndex(inputs.fixtures, inputs.groups);
  const result: ReferencePruneResult = {
    groups: [],
    cues: [],
    fx: [],
    stepFx: [],
    fxModules: [],
    flows: [],
    prunedReferenceCount: 0,
  };

  for (const group of Object.values(inputs.groups)) {
    const pruned = pruneSpatialSelection(group.selection, fixtureIndex);
    if (!pruned.changed) continue;
    result.groups.push({ ...group, selection: pruned.selection });
    result.prunedReferenceCount += pruned.prunedReferenceCount;
  }

  for (const cue of Object.values(inputs.cues)) {
    const nextCue = cloneCueForPrune(cue);
    let changed = false;
    for (const instruction of nextCue.instructions) {
      const pruned = pruneSpatialSelection(instruction.selection, fixtureIndex);
      instruction.selection = pruned.selection;
      changed ||= pruned.changed;
      result.prunedReferenceCount += pruned.prunedReferenceCount;
    }
    for (const part of nextCue.parts ?? []) {
      for (const instruction of part.instructions) {
        const pruned = pruneSpatialSelection(
          instruction.selection,
          fixtureIndex,
        );
        instruction.selection = pruned.selection;
        changed ||= pruned.changed;
        result.prunedReferenceCount += pruned.prunedReferenceCount;
      }
    }
    if (changed) result.cues.push(nextCue);
  }

  for (const fx of Object.values(inputs.fx)) {
    const pruned = pruneSpatialSelection(fx.selection, fixtureIndex);
    if (!pruned.changed) continue;
    result.fx.push({ ...fx, selection: pruned.selection });
    result.prunedReferenceCount += pruned.prunedReferenceCount;
  }

  for (const stepFx of Object.values(inputs.stepFx)) {
    const pruned = pruneSpatialSelection(stepFx.selection, fixtureIndex);
    if (!pruned.changed) continue;
    result.stepFx.push({ ...stepFx, selection: pruned.selection });
    result.prunedReferenceCount += pruned.prunedReferenceCount;
  }

  for (const fxModule of Object.values(inputs.fxModules)) {
    const pruned = pruneSpatialSelection(fxModule.selection, fixtureIndex);
    if (!pruned.changed) continue;
    result.fxModules.push({ ...fxModule, selection: pruned.selection });
    result.prunedReferenceCount += pruned.prunedReferenceCount;
  }

  for (const flow of Object.values(inputs.flows)) {
    const nextFlow = cloneFlowForPrune(flow);
    let changed = false;
    for (const node of nextFlow.nodes) {
      for (const port of node.ports) {
        if (port.default_value?.type !== "Selection") continue;
        const pruned = pruneSpatialSelection(
          port.default_value.data,
          fixtureIndex,
        );
        port.default_value = { type: "Selection", data: pruned.selection };
        changed ||= pruned.changed;
        result.prunedReferenceCount += pruned.prunedReferenceCount;
      }
    }
    if (changed) result.flows.push(nextFlow);
  }

  return result;
}

/** Clones the cue containers that prune mutates without invoking browser structured cloning. */
function cloneCueForPrune(cue: types.Cue): types.Cue {
  return {
    ...cue,
    instructions: cue.instructions.map(cloneBoundCueInstructionForPrune),
    parts: cue.parts?.map((part) => ({
      ...part,
      instructions: part.instructions.map(cloneBoundCueInstructionForPrune),
    })),
  };
}

/** Clones a cue instruction wrapper so its selection can be replaced safely. */
function cloneBoundCueInstructionForPrune(
  instruction: types.BoundCueInstruction,
): types.BoundCueInstruction {
  return { ...instruction };
}

/** Clones flow containers that prune mutates without invoking browser structured cloning. */
function cloneFlowForPrune(flow: types.FlowDefinition): types.FlowDefinition {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => ({
      ...node,
      ports: node.ports.map((port) => ({ ...port })),
    })),
    edges: flow.edges.map((edge) => ({ ...edge })),
  };
}

/** Formats an audit issue reason into compact UI copy. */
export function referenceIssueReasonLabel(
  reason: ReferenceIssueReason,
): string {
  switch (reason) {
    case "missing-fixture-uid":
      return "Missing fixture UID";
    case "missing-fixture-id":
      return "Missing fixture ID";
    case "missing-fixture-element":
      return "Missing element";
    case "missing-group-uid":
      return "Missing group UID";
    case "missing-group-id":
      return "Missing group";
    case "missing-blueprint-uid":
      return "Missing Blueprint UID";
    case "missing-network-output-target":
      return "Missing output transport target";
  }
}

/** Returns a human label for a reference source domain. */
export function referenceDomainLabel(domain: ReferenceAuditDomain): string {
  switch (domain) {
    case "group":
      return "Group";
    case "cue":
      return "Cue";
    case "sequence":
      return "Sequence";
    case "fx":
      return "FX";
    case "stepFx":
      return "Step FX";
    case "fxModule":
      return "FX Module";
    case "flow":
      return "Flow";
    case "patchBinding":
      return "Patch Binding";
  }
}

/** Builds fixture and group lookup tables for reference validation. */
function buildFixtureIndex(
  fixtures: Record<string, types.Fixture>,
  groups: Record<string, types.Group>,
): FixtureIndex {
  return {
    fixtureIds: new Set(
      Object.values(fixtures).map((fixture) => fixture.identifiers.id),
    ),
    groupByUid: new Map(
      Object.values(groups).map((group) => [group.identifiers.uid, group]),
    ),
    groupById: new Map(
      Object.values(groups).map((group) => [group.identifiers.id, group]),
    ),
    groupByLabel: new Map(
      Object.values(groups).map((group) => [group.identifiers.label, group]),
    ),
    fixtureByUid: new Map(
      Object.values(fixtures).map((fixture) => [
        fixture.identifiers.uid,
        fixture,
      ]),
    ),
    fixtureById: new Map(
      Object.values(fixtures).map((fixture) => [
        fixture.identifiers.id,
        fixture,
      ]),
    ),
  };
}

/** Audits a spatial selection and all union branches it composes. */
function auditSpatialSelection(
  selection: types.SpatialSelection,
  context: SelectionAuditContext,
): SelectionAuditResult {
  const sourceResult = auditSelectionExpr(selection.source, context);
  const unionResults = (selection.union ?? []).map((unionSelection, index) =>
    auditSpatialSelection(unionSelection, {
      ...context,
      path: spatialUnionSourcePath(context.path, index),
    }),
  );
  return {
    references: [
      ...sourceResult.references,
      ...unionResults.flatMap((result) => result.references),
    ],
    issues: [
      ...sourceResult.issues,
      ...unionResults.flatMap((result) => result.issues),
    ],
    referenceCount:
      sourceResult.referenceCount +
      unionResults.reduce((total, result) => total + result.referenceCount, 0),
  };
}

/** Builds the source path for a spatial union branch from the current source path. */
function spatialUnionSourcePath(sourcePath: string, index: number): string {
  const basePath = sourcePath.endsWith(".source")
    ? sourcePath.slice(0, -".source".length)
    : sourcePath;
  return `${basePath}.union[${index}].source`;
}

/** Audits one selection expression and all nested child expressions. */
function auditSelectionExpr(
  expr: types.SelectionExpr,
  context: SelectionAuditContext,
): SelectionAuditResult {
  switch (expr.type) {
    case "Resolved": {
      const results = expr.data.map((fixtureRef, index) =>
        auditResolvedFixtureRef(
          fixtureRef,
          `${context.path}.Resolved[${index}]`,
          context,
        ),
      );
      return {
        references: results.map((result) => result.reference),
        issues: results.flatMap((result) => result.issues),
        referenceCount: expr.data.length,
      };
    }
    case "Fixture": {
      const result = auditUnresolvedFixtureRef(
        expr.data,
        context.path,
        context,
      );
      return {
        references: [result.reference],
        issues: result.issues,
        referenceCount: 1,
      };
    }
    case "FixtureRange": {
      const targets = expandFixtureRangeTargets(
        expr.data.start.fixture_id,
        expr.data.start.element_index,
        expr.data.end.fixture_id,
        expr.data.end.element_index,
        context.fixtures,
      );
      const results = targets.map((target) =>
        auditFixtureRangeTarget(target, context),
      );
      return {
        references: results.map((result) => result.reference),
        issues: results.flatMap((result) => result.issues),
        referenceCount: targets.length,
      };
    }
    case "FixtureMap": {
      const fixtureIds = expandNumericRange(
        expr.data.fixtures.start,
        expr.data.fixtures.end,
      );
      const elementIndexes = expandElementSelector(expr.data.elements);
      const references = fixtureIds.flatMap((fixtureId) =>
        elementIndexes.map((elementIndex) =>
          referenceEntry(
            context,
            context.path,
            "fixture",
            `Fixture ${fixtureId}.${elementIndex}`,
            isValidFixtureElement(fixtureId, elementIndex, context.fixtures)
              ? "ok"
              : "missing",
          ),
        ),
      );
      const issues = fixtureIds.flatMap((fixtureId) => {
        const fixture = context.fixtures.fixtureById.get(fixtureId);
        if (!fixture) {
          return [
            referenceIssue(
              context,
              context.path,
              "fixture",
              `Fixture ${fixtureId}`,
              "missing-fixture-id",
              false,
            ),
          ];
        }
        return elementIndexes.flatMap((elementIndex) =>
          isValidElementIndex(elementIndex, fixture)
            ? []
            : [
                referenceIssue(
                  context,
                  context.path,
                  "fixture",
                  `Fixture ${fixtureId}.${elementIndex}`,
                  "missing-fixture-element",
                  false,
                ),
              ],
        );
      });
      return {
        references,
        issues,
        referenceCount: fixtureIds.length * elementIndexes.length,
      };
    }
    case "Group": {
      return auditGroupRefExpr(expr.data, context);
    }
    case "Add":
    case "Sub": {
      const lhs = auditSelectionExpr(expr.data.lhs, {
        ...context,
        path: `${context.path}.${expr.type}.lhs`,
      });
      const rhs = auditSelectionExpr(expr.data.rhs, {
        ...context,
        path: `${context.path}.${expr.type}.rhs`,
      });
      return {
        references: [...lhs.references, ...rhs.references],
        issues: [...lhs.issues, ...rhs.issues],
        referenceCount: lhs.referenceCount + rhs.referenceCount,
      };
    }
    case "Span": {
      return auditSelectionExpr(expr.data, {
        ...context,
        path: `${context.path}.Span`,
      });
    }
    case "Spatial": {
      return auditSpatialSelection(expr.data, {
        ...context,
        path: `${context.path}.Spatial.source`,
      });
    }
  }
}

/** Audits one concrete target produced from a fixture range expression. */
function auditFixtureRangeTarget(
  target: FixtureRangeTarget,
  context: SelectionAuditContext,
): { reference: ReferenceEntry; issues: ReferenceIssue[] } {
  if (target.elementIndex === undefined) {
    const targetLabel = `Fixture ${target.fixtureId}`;
    if (context.fixtures.fixtureIds.has(target.fixtureId)) {
      return {
        reference: referenceEntry(
          context,
          context.path,
          "fixture",
          targetLabel,
          "ok",
        ),
        issues: [],
      };
    }
    return {
      reference: referenceEntry(
        context,
        context.path,
        "fixture",
        targetLabel,
        "missing",
      ),
      issues: [
        referenceIssue(
          context,
          context.path,
          "fixture",
          targetLabel,
          "missing-fixture-id",
          false,
        ),
      ],
    };
  }

  const targetLabel = `Fixture ${target.fixtureId}.${target.elementIndex}`;
  const fixture = context.fixtures.fixtureById.get(target.fixtureId);
  if (!fixture) {
    return {
      reference: referenceEntry(
        context,
        context.path,
        "fixture",
        targetLabel,
        "missing",
      ),
      issues: [
        referenceIssue(
          context,
          context.path,
          "fixture",
          `Fixture ${target.fixtureId}`,
          "missing-fixture-id",
          false,
        ),
      ],
    };
  }
  if (isValidElementIndex(target.elementIndex, fixture)) {
    return {
      reference: referenceEntry(
        context,
        context.path,
        "fixture",
        targetLabel,
        "ok",
      ),
      issues: [],
    };
  }
  return {
    reference: referenceEntry(
      context,
      context.path,
      "fixture",
      targetLabel,
      "missing",
    ),
    issues: [
      referenceIssue(
        context,
        context.path,
        "fixture",
        targetLabel,
        "missing-fixture-element",
        false,
      ),
    ],
  };
}

/** Builds issues for a resolved fixture reference by UID. */
function auditResolvedFixtureRef(
  fixtureRef: types.FixtureRef,
  path: string,
  context: SelectionAuditContext,
): { reference: ReferenceEntry; issues: ReferenceIssue[] } {
  const fixture = context.fixtures.fixtureByUid.get(fixtureRef.fixture_uid);
  if (!fixture) {
    const reference = referenceEntry(
      context,
      path,
      "fixture",
      fixtureRef.fixture_uid,
      "missing",
    );
    return {
      reference,
      issues: [
        referenceIssue(
          context,
          path,
          "fixture",
          fixtureRef.fixture_uid,
          "missing-fixture-uid",
          true,
        ),
      ],
    };
  }
  if (
    fixtureRef.index !== undefined &&
    (fixtureRef.index < 1 || fixtureRef.index > fixture.elements.length)
  ) {
    const targetLabel = `Fixture ${fixture.identifiers.id}.${fixtureRef.index}`;
    return {
      reference: referenceEntry(
        context,
        path,
        "fixture",
        targetLabel,
        "missing",
      ),
      issues: [
        referenceIssue(
          context,
          path,
          "fixture",
          targetLabel,
          "missing-fixture-element",
          true,
        ),
      ],
    };
  }
  const targetLabel =
    fixtureRef.index === undefined
      ? `Fixture ${fixture.identifiers.id}`
      : `Fixture ${fixture.identifiers.id}.${fixtureRef.index}`;
  return {
    reference: referenceEntry(context, path, "fixture", targetLabel, "ok"),
    issues: [],
  };
}

/** Builds issues for an unresolved fixture reference by user-facing fixture ID. */
function auditUnresolvedFixtureRef(
  fixtureRef: types.UnresolvedFixtureRef,
  path: string,
  context: SelectionAuditContext,
): { reference: ReferenceEntry; issues: ReferenceIssue[] } {
  const targetLabel =
    fixtureRef.element_index === undefined
      ? `Fixture ${fixtureRef.fixture_id}`
      : `Fixture ${fixtureRef.fixture_id}.${fixtureRef.element_index}`;
  if (!context.fixtures.fixtureIds.has(fixtureRef.fixture_id)) {
    return {
      reference: referenceEntry(
        context,
        path,
        "fixture",
        targetLabel,
        "missing",
      ),
      issues: [
        referenceIssue(
          context,
          path,
          "fixture",
          `Fixture ${fixtureRef.fixture_id}`,
          "missing-fixture-id",
          false,
        ),
      ],
    };
  }
  if (
    fixtureRef.element_index !== undefined &&
    !isValidFixtureElement(
      fixtureRef.fixture_id,
      fixtureRef.element_index,
      context.fixtures,
    )
  ) {
    return {
      reference: referenceEntry(
        context,
        path,
        "fixture",
        targetLabel,
        "missing",
      ),
      issues: [
        referenceIssue(
          context,
          path,
          "fixture",
          targetLabel,
          "missing-fixture-element",
          false,
        ),
      ],
    };
  }
  return {
    reference: referenceEntry(context, path, "fixture", targetLabel, "ok"),
    issues: [],
  };
}

/** Creates one stable reference row. */
function referenceEntry(
  context: SelectionAuditContext,
  path: string,
  targetKind: ReferenceTargetKind,
  targetLabel: string,
  status: ReferenceEntry["status"],
): ReferenceEntry {
  const id = [
    context.source.domain,
    context.source.uid,
    path,
    targetKind,
    targetLabel,
  ].join(":");
  return {
    id,
    source: context.source,
    path,
    targetKind,
    targetLabel,
    status,
  };
}

/** Creates one stable reference issue row. */
function referenceIssue(
  context: SelectionAuditContext,
  path: string,
  targetKind: ReferenceTargetKind,
  targetLabel: string,
  reason: ReferenceIssueReason,
  prunable: boolean,
): ReferenceIssue {
  const id = [
    context.source.domain,
    context.source.uid,
    path,
    targetKind,
    targetLabel,
    reason,
  ].join(":");
  return {
    id,
    source: context.source,
    path,
    targetKind,
    targetLabel,
    reason,
    prunable,
  };
}

/** Prunes invalid resolved fixture references from a spatial selection. */
function pruneSpatialSelection(
  selection: types.SpatialSelection,
  fixtureIndex: FixtureIndex,
): SelectionPruneResult {
  const prunedSource = pruneSelectionExpr(selection.source, fixtureIndex);
  const prunedUnion = (selection.union ?? []).map((unionSelection) =>
    pruneSpatialSelection(unionSelection, fixtureIndex),
  );
  const nextSelection =
    selection.union === undefined
      ? { ...selection, source: prunedSource.expr }
      : {
          ...selection,
          source: prunedSource.expr,
          union: prunedUnion.map((result) => result.selection),
        };
  return {
    selection: nextSelection,
    changed:
      prunedSource.changed || prunedUnion.some((result) => result.changed),
    prunedReferenceCount:
      prunedSource.prunedReferenceCount +
      prunedUnion.reduce(
        (total, result) => total + result.prunedReferenceCount,
        0,
      ),
  };
}

/** Prunes invalid resolved fixture references from one selection expression. */
function pruneSelectionExpr(
  expr: types.SelectionExpr,
  fixtureIndex: FixtureIndex,
): {
  expr: types.SelectionExpr;
  changed: boolean;
  prunedReferenceCount: number;
} {
  switch (expr.type) {
    case "Resolved": {
      const next = expr.data.filter((fixtureRef) =>
        isValidResolvedFixtureRef(fixtureRef, fixtureIndex),
      );
      return {
        expr: { type: "Resolved", data: next },
        changed: next.length !== expr.data.length,
        prunedReferenceCount: expr.data.length - next.length,
      };
    }
    case "Add":
    case "Sub": {
      const lhs = pruneSelectionExpr(expr.data.lhs, fixtureIndex);
      const rhs = pruneSelectionExpr(expr.data.rhs, fixtureIndex);
      return {
        expr: {
          type: expr.type,
          data: { lhs: lhs.expr, rhs: rhs.expr },
        },
        changed: lhs.changed || rhs.changed,
        prunedReferenceCount:
          lhs.prunedReferenceCount + rhs.prunedReferenceCount,
      };
    }
    case "Span": {
      const pruned = pruneSelectionExpr(expr.data, fixtureIndex);
      return {
        expr: { type: "Span", data: pruned.expr },
        changed: pruned.changed,
        prunedReferenceCount: pruned.prunedReferenceCount,
      };
    }
    case "Spatial": {
      const pruned = pruneSpatialSelection(expr.data, fixtureIndex);
      return {
        expr: { type: "Spatial", data: pruned.selection },
        changed: pruned.changed,
        prunedReferenceCount: pruned.prunedReferenceCount,
      };
    }
    default:
      return { expr, changed: false, prunedReferenceCount: 0 };
  }
}

/** Checks whether a resolved fixture reference points at a live fixture element. */
function isValidResolvedFixtureRef(
  fixtureRef: types.FixtureRef,
  fixtureIndex: FixtureIndex,
): boolean {
  const fixture = fixtureIndex.fixtureByUid.get(fixtureRef.fixture_uid);
  if (!fixture) return false;
  if (fixtureRef.index === undefined) return true;
  return fixtureRef.index >= 1 && fixtureRef.index <= fixture.elements.length;
}

/** Checks whether an unresolved fixture element points at a live element. */
function isValidFixtureElement(
  fixtureId: number,
  elementIndex: number,
  fixtureIndex: FixtureIndex,
): boolean {
  const fixture = fixtureIndex.fixtureById.get(fixtureId);
  return fixture !== undefined && isValidElementIndex(elementIndex, fixture);
}

/** Checks whether an element index is valid for one fixture definition. */
function isValidElementIndex(
  elementIndex: number,
  fixture: types.Fixture,
): boolean {
  return elementIndex >= 1 && elementIndex <= fixture.elements.length;
}

/** Expands a fixture range into concrete whole-fixture or element-level targets. */
function expandFixtureRangeTargets(
  startFixtureId: number,
  startElementIndex: number | undefined,
  endFixtureId: number,
  endElementIndex: number | undefined,
  fixtureIndex: FixtureIndex,
): FixtureRangeTarget[] {
  const start = {
    fixtureId: startFixtureId,
    elementIndex: startElementIndex,
  };
  const end = {
    fixtureId: endFixtureId,
    elementIndex: endElementIndex,
  };
  const reverse = compareUnresolvedFixtureRefs(start, end) > 0;
  const lower = reverse ? end : start;
  const upper = reverse ? start : end;
  const targets: FixtureRangeTarget[] = [];
  const useWholeFixtures =
    lower.elementIndex === undefined && upper.elementIndex === undefined;

  for (
    let fixtureId = lower.fixtureId;
    fixtureId <= upper.fixtureId;
    fixtureId += 1
  ) {
    const fixture = fixtureIndex.fixtureById.get(fixtureId);
    if (useWholeFixtures || !fixture) {
      targets.push({ fixtureId });
      continue;
    }

    const elementStart =
      fixtureId === lower.fixtureId ? (lower.elementIndex ?? 1) : 1;
    const elementEnd =
      fixtureId === upper.fixtureId
        ? (upper.elementIndex ?? fixture.elements.length)
        : fixture.elements.length;

    if (elementStart <= elementEnd) {
      for (
        let elementIndex = elementStart;
        elementIndex <= elementEnd;
        elementIndex += 1
      ) {
        targets.push({ fixtureId, elementIndex });
      }
      continue;
    }

    if (fixtureId === lower.fixtureId && lower.elementIndex !== undefined) {
      targets.push({ fixtureId, elementIndex: lower.elementIndex });
    }
    if (
      fixtureId === upper.fixtureId &&
      upper.elementIndex !== undefined &&
      upper.elementIndex !== lower.elementIndex
    ) {
      targets.push({ fixtureId, elementIndex: upper.elementIndex });
    }
  }

  return reverse ? targets.reverse() : targets;
}

/** Compares unresolved fixture references using the Rust ordering semantics. */
function compareUnresolvedFixtureRefs(
  left: FixtureRangeTarget,
  right: FixtureRangeTarget,
): number {
  return (
    left.fixtureId - right.fixtureId ||
    compareOptionalNumbers(left.elementIndex, right.elementIndex)
  );
}

/** Compares optional numbers with undefined ordered before defined values. */
function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left - right;
}

/** Audits one group reference expression and all nested child expressions. */
function auditGroupRefExpr(
  expr: types.GroupRefExpr,
  context: SelectionAuditContext,
): SelectionAuditResult {
  switch (expr.type) {
    case "ByUid": {
      const uid = expr.data.uid;
      const group = context.fixtures.groupByUid.get(uid);
      const label = group
        ? `Group ${group.identifiers.id}`
        : `Group UID ${uid}`;
      return groupReferenceResult(
        context,
        label,
        group ? "ok" : "missing",
        group ? undefined : "missing-group-uid",
      );
    }
    case "ById": {
      const groupId = expr.data;
      return groupReferenceResult(
        context,
        `Group ${groupId}`,
        context.fixtures.groupById.has(groupId) ? "ok" : "missing",
        context.fixtures.groupById.has(groupId)
          ? undefined
          : "missing-group-id",
      );
    }
    case "ByLabel": {
      const label = expr.data;
      return groupReferenceResult(
        context,
        `Group "${label}"`,
        context.fixtures.groupByLabel.has(label) ? "ok" : "missing",
        context.fixtures.groupByLabel.has(label)
          ? undefined
          : "missing-group-id",
      );
    }
    case "RangeById": {
      const groupIds = expandNumericRange(expr.data.start, expr.data.end);
      return combineSelectionAuditResults(
        groupIds.map((groupId) =>
          groupReferenceResult(
            context,
            `Group ${groupId}`,
            context.fixtures.groupById.has(groupId) ? "ok" : "missing",
            context.fixtures.groupById.has(groupId)
              ? undefined
              : "missing-group-id",
          ),
        ),
      );
    }
    case "MissingById":
      return groupReferenceResult(
        context,
        `Group ${expr.data}`,
        "missing",
        "missing-group-id",
      );
    case "MissingByLabel":
      return groupReferenceResult(
        context,
        `Group "${expr.data}"`,
        "missing",
        "missing-group-id",
      );
    case "Add":
    case "Sub": {
      return combineSelectionAuditResults([
        auditGroupRefExpr(expr.data.lhs, context),
        auditGroupRefExpr(expr.data.rhs, context),
      ]);
    }
    case "Span":
      return auditGroupRefExpr(expr.data, context);
  }
}

/** Builds a single-reference audit result for a group target. */
function groupReferenceResult(
  context: SelectionAuditContext,
  label: string,
  status: "ok" | "missing",
  reason: ReferenceIssueReason | undefined,
): SelectionAuditResult {
  return {
    references: [referenceEntry(context, context.path, "group", label, status)],
    issues:
      reason === undefined
        ? []
        : [
            referenceIssue(
              context,
              context.path,
              "group",
              label,
              reason,
              false,
            ),
          ],
    referenceCount: 1,
  };
}

/** Combines nested selection audit results into one result. */
function combineSelectionAuditResults(
  results: SelectionAuditResult[],
): SelectionAuditResult {
  return {
    references: results.flatMap((result) => result.references),
    issues: results.flatMap((result) => result.issues),
    referenceCount: results.reduce(
      (total, result) => total + result.referenceCount,
      0,
    ),
  };
}

/** Expands an element selector into concrete 1-based element indexes. */
function expandElementSelector(expr: types.ElementSelectorExpr): number[] {
  switch (expr.type) {
    case "Single":
      return [expr.data];
    case "Range":
      return expandNumericRange(expr.data.start, expr.data.end);
  }
}

/** Expands an inclusive numeric range in either direction. */
function expandNumericRange(start: number, end: number): number[] {
  const step = start <= end ? 1 : -1;
  const result: number[] = [];
  for (let value = start; ; value += step) {
    result.push(value);
    if (value === end) break;
  }
  return result;
}

/** Creates a stable audit source descriptor for one output patch binding row. */
function outputBindingObject(index: number): ReferenceAuditObject {
  const displayIndex = index + 1;
  return {
    domain: "patchBinding",
    uid: `output-binding-${index}`,
    id: displayIndex,
    label: `Output binding ${displayIndex}`,
    kindLabel: "Patch Binding",
  };
}

/** Converts a group into audit source metadata. */
function groupObject(group: types.Group): ReferenceAuditObject {
  return {
    domain: "group",
    uid: group.identifiers.uid,
    id: group.identifiers.id,
    label: group.identifiers.label,
    kindLabel: "Group",
  };
}

/** Converts a cue into audit source metadata. */
function cueObject(cue: types.Cue): ReferenceAuditObject {
  return {
    domain: "cue",
    uid: cue.identifiers.uid,
    id: cue.identifiers.id,
    label: cue.identifiers.label,
    kindLabel: "Cue",
  };
}

/** Converts a sequence and its embedded cues into audit source metadata. */
function sequenceObject(sequence: types.Sequence): ReferenceAuditObject {
  return {
    domain: "sequence",
    uid: sequence.identifiers.uid,
    id: sequence.identifiers.id,
    label: sequence.identifiers.label,
    kindLabel: "Sequence",
  };
}

/** Converts an FX definition into audit source metadata. */
function fxObject(fx: types.Fx): ReferenceAuditObject {
  return {
    domain: "fx",
    uid: fx.identifiers.uid,
    id: fx.identifiers.id,
    label: fx.identifiers.label,
    kindLabel: "FX",
  };
}

/** Converts a step FX definition into audit source metadata. */
function stepFxObject(stepFx: types.StepFx): ReferenceAuditObject {
  return {
    domain: "stepFx",
    uid: stepFx.identifiers.uid,
    id: stepFx.identifiers.id,
    label: stepFx.identifiers.label,
    kindLabel: "Step FX",
  };
}

/** Converts an FX module definition into audit source metadata. */
function fxModuleObject(fxModule: types.StoredFxModule): ReferenceAuditObject {
  return {
    domain: "fxModule",
    uid: fxModule.identifiers.uid,
    id: fxModule.identifiers.id,
    label: fxModule.identifiers.label,
    kindLabel: "FX Module",
  };
}

/** Converts a flow definition into audit source metadata. */
function flowObject(flow: types.FlowDefinition): ReferenceAuditObject {
  return {
    domain: "flow",
    uid: flow.identifiers.uid,
    id: flow.identifiers.id,
    label: flow.identifiers.label,
    kindLabel: "Flow",
  };
}

/** Sorts issues by domain, object ID, path, and target label. */
function compareReferenceIssues(
  left: ReferenceIssue,
  right: ReferenceIssue,
): number {
  return (
    left.source.kindLabel.localeCompare(right.source.kindLabel) ||
    left.source.id - right.source.id ||
    left.path.localeCompare(right.path) ||
    left.targetLabel.localeCompare(right.targetLabel)
  );
}

/** Sorts references by target, source domain, source ID, and path. */
function compareReferenceEntries(
  left: ReferenceEntry,
  right: ReferenceEntry,
): number {
  return (
    left.targetKind.localeCompare(right.targetKind) ||
    left.targetLabel.localeCompare(right.targetLabel) ||
    left.source.kindLabel.localeCompare(right.source.kindLabel) ||
    left.source.id - right.source.id ||
    left.path.localeCompare(right.path)
  );
}
