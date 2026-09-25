// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Evaluation of fixture channel output the way a fixture interprets it.
 *
 * Each parameter's output value is converted to the DMX value the console
 * sends, the profile function active at that value is selected (honouring
 * mode master conditions on other channels), and the value is mapped to the
 * function's physical scale through channel sets or DMX profiles. Relations
 * are then applied: those whose master is a real channel are evaluated here,
 * as the fixture would, while relations with virtual masters have already
 * been applied to the output by the console.
 */

import { getResolutionChannelWidth } from "../../../lib/dmx";
import {
  type Attribute,
  type ElementParameterRef,
  type FixtureElement,
  type ParameterFunction,
  type ParameterFunctionSet,
  type ParameterMetadata,
  ParameterValuePolarity,
  type ProfilePoint,
  RelationKind,
} from "../../../types";

/** A parameter's output as the fixture interprets it. */
export interface EvaluatedChannel {
  /** Parameter metadata. */
  parameter: ParameterMetadata;
  /** Logical output value, in the parameter's native unit. */
  value: number;
  /** DMX value sent for the output, at the parameter's resolution. */
  dmx: number;
  /** Profile function active at `dmx`, if the parameter declares functions. */
  function?: ParameterFunction;
  /** Channel set of the active function containing `dmx`. */
  set?: ParameterFunctionSet;
  /**
   * Position within the active function (or the whole range without
   * functions), 0-1, after the function's DMX profile.
   */
  fraction: number;
  /**
   * Physical value of the active function, from its set's own range when the
   * set declares one. Without functions, the logical output value.
   */
  physical: number;
  /** Output level 0-1 after relations with physical masters. */
  level: number;
  /** Whether this parameter is a relation master of a channel in its own element. */
  mastersOwnElement: boolean;
}

/** A parameter reference resolved to `[element index, parameter index]`. */
type ResolvedRef = readonly [number, number];

/** Precomputed link targets of one parameter's functions. */
interface CompiledParameter {
  /** Output record key. */
  key: string;
  /** Mode master of each function, index-aligned with `functions`. */
  modeMasters: (ResolvedRef | undefined)[];
  /** Relation masters of each function with their kinds. */
  relations: { master: ResolvedRef; kind: RelationKind }[][];
  /** Whether a function of a parameter in the same element follows this one. */
  mastersOwnElement: boolean;
  /** Whether this parameter masters or follows any relation. */
  linked: boolean;
}

/** Link targets for every parameter of a fixture. */
interface CompiledFixture {
  /** Per element, per parameter. */
  parameters: CompiledParameter[][];
  /**
   * Dimmers no relation mentions. A profile states what its linked dimmers
   * control; an unlinked dimmer is assumed to master the whole fixture.
   */
  unlinkedDimmers: ResolvedRef[];
}

/** Returns true for attributes that dim an element. */
function isDimmer(attribute: Attribute): boolean {
  return (
    attribute.type === "Intensity" || attribute.type === "VirtualIntensity"
  );
}

/** Longest chain of relation masters followed before a cycle is assumed. */
const MAX_RELATION_DEPTH = 8;

const compiledFixtures = new WeakMap<FixtureElement[], CompiledFixture>();
const compiledElements = new WeakMap<FixtureElement, CompiledFixture>();

/** Returns the output record key of an attribute. */
export function attributeOutputKey(attribute: Attribute): string {
  return attribute.type === "Custom" ? attribute.data.label : attribute.type;
}

/** Returns true when two attributes are the same attribute. */
function sameAttribute(a: Attribute, b: Attribute): boolean {
  return attributeOutputKey(a) === attributeOutputKey(b) && a.type === b.type;
}

/**
 * Resolves element-scoped links for a fixture's parameters once.
 *
 * With `linked` false, links are ignored; this evaluates a lone element
 * whose references into other elements cannot be followed.
 */
function compile(elements: FixtureElement[], linked: boolean): CompiledFixture {
  const resolve = (
    ref: ElementParameterRef | undefined,
  ): ResolvedRef | undefined => {
    if (!ref || !linked) return undefined;
    const parameter = elements[ref.element]?.parameters.findIndex((candidate) =>
      sameAttribute(candidate.attribute, ref.attribute),
    );
    return parameter === undefined || parameter < 0
      ? undefined
      : [ref.element, parameter];
  };
  const parameters: CompiledParameter[][] = elements.map((element) =>
    element.parameters.map((parameter) => {
      const functions = parameter.functions ?? [];
      const relations = functions.map((fn) =>
        (fn.relations ?? []).flatMap((relation) => {
          const master = resolve(relation.master);
          return master ? [{ master, kind: relation.kind }] : [];
        }),
      );
      return {
        key: attributeOutputKey(parameter.attribute),
        modeMasters: functions.map((fn) => resolve(fn.mode_master?.master)),
        relations,
        mastersOwnElement: false,
        linked: relations.some((fnRelations) => fnRelations.length > 0),
      };
    }),
  );
  parameters.forEach((element, elementIndex) => {
    for (const parameter of element) {
      for (const relation of parameter.relations.flat()) {
        const [masterElement, masterParameter] = relation.master;
        const master = parameters[masterElement][masterParameter];
        master.linked = true;
        if (masterElement === elementIndex) master.mastersOwnElement = true;
      }
    }
  });
  const unlinkedDimmers: ResolvedRef[] = [];
  elements.forEach((element, elementIndex) => {
    element.parameters.forEach((parameter, parameterIndex) => {
      if (
        isDimmer(parameter.attribute) &&
        !parameters[elementIndex][parameterIndex].linked
      ) {
        unlinkedDimmers.push([elementIndex, parameterIndex]);
      }
    });
  });
  return { parameters, unlinkedDimmers };
}

/** Returns the lowest logical value of a parameter, matching the engine. */
function logicalMin(parameter: ParameterMetadata): number {
  return parameter.value_polarity === ParameterValuePolarity.Signed &&
    parameter.min >= 0
    ? -(parameter.max - parameter.min) / 2
    : parameter.min;
}

/** Returns the highest logical value of a parameter, matching the engine. */
function logicalMax(parameter: ParameterMetadata): number {
  return parameter.value_polarity === ParameterValuePolarity.Signed &&
    parameter.min >= 0
    ? (parameter.max - parameter.min) / 2
    : parameter.max;
}

/** Returns the highest DMX value at a parameter's resolution. */
function dmxMax(parameter: ParameterMetadata): number {
  return 2 ** (8 * getResolutionChannelWidth(parameter.resolution)) - 1;
}

/** Returns an output value's position in the parameter's logical range, 0-1. */
function normalizedOutput(parameter: ParameterMetadata, value: number): number {
  const min = logicalMin(parameter);
  const range = logicalMax(parameter) - min;
  return range > 0 ? Math.min(1, Math.max(0, (value - min) / range)) : 0;
}

/**
 * Evaluates a DMX profile at a DMX percentage (0-100), returning a physical
 * percentage. Mirrors `evaluate_profile` in the fixtures crate.
 */
export function evaluateProfile(
  points: ProfilePoint[],
  dmxPercent: number,
): number {
  let point = points[0];
  if (!point) return dmxPercent;
  for (const candidate of points) {
    if (candidate.dmx_percent <= dmxPercent) point = candidate;
  }
  const d = dmxPercent - point.dmx_percent;
  return point.cfc0 + d * (point.cfc1 + d * (point.cfc2 + d * point.cfc3));
}

/** Returns a value's 0-1 position within an inclusive DMX range. */
function position(dmx: number, from: number, to: number): number {
  return to > from ? Math.min(1, Math.max(0, (dmx - from) / (to - from))) : 1;
}

/**
 * Fills an evaluated channel's function, set, fraction and physical value
 * for the function at `functionIndex`, or the whole range when undefined.
 */
function applyFunction(
  channel: EvaluatedChannel,
  functionIndex: number | undefined,
): void {
  const fn =
    functionIndex === undefined
      ? undefined
      : channel.parameter.functions?.[functionIndex];
  channel.function = fn;
  channel.set = undefined;
  if (!fn) {
    channel.fraction = normalizedOutput(channel.parameter, channel.value);
    channel.physical = channel.value;
    channel.level = channel.fraction;
    return;
  }
  const linear = position(channel.dmx, fn.dmx_from, fn.dmx_to);
  channel.fraction = fn.profile?.length
    ? Math.min(1, Math.max(0, evaluateProfile(fn.profile, linear * 100) / 100))
    : linear;
  channel.physical =
    fn.physical_from + (fn.physical_to - fn.physical_from) * channel.fraction;
  const set = fn.sets?.find(
    (candidate) =>
      channel.dmx >= candidate.dmx_from && channel.dmx <= candidate.dmx_to,
  );
  channel.set = set;
  if (set?.physical_from !== undefined && set.physical_to !== undefined) {
    channel.physical =
      set.physical_from +
      (set.physical_to - set.physical_from) *
        position(channel.dmx, set.dmx_from, set.dmx_to);
  }
  channel.level = channel.fraction;
}

/** Evaluates every parameter of a fixture using precompiled links. */
function evaluate(
  elements: FixtureElement[],
  outputs: (Record<string, number> | undefined)[],
  compiled: CompiledFixture,
): (EvaluatedChannel | undefined)[][] {
  const channels = elements.map((element, elementIndex) =>
    element.parameters.map((parameter, parameterIndex) => {
      const output = outputs[elementIndex];
      const key = compiled.parameters[elementIndex][parameterIndex].key;
      const value =
        parameter.attribute.type === "VirtualIntensity"
          ? (output?.VirtualIntensity ?? output?.Intensity)
          : output?.[key];
      if (value === undefined || parameter.max <= 0) return undefined;
      const channel: EvaluatedChannel = {
        parameter,
        value,
        dmx: Math.round(normalizedOutput(parameter, value) * dmxMax(parameter)),
        fraction: 0,
        physical: value,
        level: 0,
        mastersOwnElement:
          compiled.parameters[elementIndex][parameterIndex].mastersOwnElement,
      };
      return channel;
    }),
  );
  const at = ([element, parameter]: ResolvedRef) =>
    channels[element]?.[parameter];

  // Select functions once every DMX value is known, so mode masters in any
  // element can be read.
  channels.forEach((element, elementIndex) => {
    element.forEach((channel, parameterIndex) => {
      if (!channel) return;
      const modeMasters =
        compiled.parameters[elementIndex][parameterIndex].modeMasters;
      const index = channel.parameter.functions?.findIndex((fn, fnIndex) => {
        if (channel.dmx < fn.dmx_from || channel.dmx > fn.dmx_to) return false;
        const condition = fn.mode_master;
        const masterRef = modeMasters[fnIndex];
        if (!condition || !masterRef) return true;
        const master = at(masterRef);
        const masterDmx = master?.dmx ?? 0;
        return masterDmx >= condition.dmx_from && masterDmx <= condition.dmx_to;
      });
      applyFunction(
        channel,
        index === undefined || index < 0 ? undefined : index,
      );
    });
  });

  // Apply relations with physical masters. A master may follow masters of
  // its own, so levels resolve through the chain, once per channel.
  const resolved = new Set<EvaluatedChannel>();
  const resolveLevel = (
    [elementIndex, parameterIndex]: ResolvedRef,
    depth: number,
  ): number => {
    const channel = channels[elementIndex]?.[parameterIndex];
    if (!channel) return 0;
    if (resolved.has(channel) || !channel.function) return channel.level;
    const functionIndex = channel.parameter.functions?.indexOf(
      channel.function,
    );
    const relations =
      compiled.parameters[elementIndex][parameterIndex].relations[
        functionIndex ?? -1
      ] ?? [];
    for (const { master: masterRef, kind } of relations) {
      const master = at(masterRef);
      if (!master || master.parameter.dmx_slots?.type === "Virtual") continue;
      if (depth >= MAX_RELATION_DEPTH) break;
      const masterLevel = resolveLevel(masterRef, depth + 1);
      channel.level =
        kind === RelationKind.Multiply
          ? channel.level * masterLevel
          : masterLevel;
    }
    resolved.add(channel);
    return channel.level;
  };
  channels.forEach((element, elementIndex) => {
    element.forEach((_, parameterIndex) => {
      resolveLevel([elementIndex, parameterIndex], 0);
    });
  });
  return channels;
}

/**
 * Evaluates every parameter of a fixture, following mode masters and
 * relations across its elements. Entries are undefined for parameters
 * without output.
 */
export function evaluateFixtureChannels(
  elements: FixtureElement[],
  outputs: (Record<string, number> | undefined)[],
): (EvaluatedChannel | undefined)[][] {
  return evaluate(elements, outputs, compiledFixture(elements));
}

/** Returns a fixture's compiled links, compiling them on first use. */
function compiledFixture(elements: FixtureElement[]): CompiledFixture {
  let compiled = compiledFixtures.get(elements);
  if (!compiled) {
    compiled = compile(elements, true);
    compiledFixtures.set(elements, compiled);
  }
  return compiled;
}

/**
 * Evaluates one element's parameters on their own. Links into other
 * elements cannot be followed, so mode masters and relations are ignored.
 */
export function evaluateElementChannels(
  element: FixtureElement,
  output: Record<string, number>,
): (EvaluatedChannel | undefined)[] {
  let compiled = compiledElements.get(element);
  if (!compiled) {
    compiled = compile([element], false);
    compiledElements.set(element, compiled);
  }
  return evaluate([element], [output], compiled)[0];
}

/**
 * Returns the level of the dimmers no relation mentions, which the
 * visualizer treats as mastering the whole fixture: the brightest of them,
 * 0 when none has output, or undefined when the fixture has none.
 */
export function fixtureDimmerLevel(
  elements: FixtureElement[],
  channels: (EvaluatedChannel | undefined)[][],
): number | undefined {
  const { unlinkedDimmers } = compiledFixture(elements);
  if (unlinkedDimmers.length === 0) return undefined;
  let level = 0;
  for (const [element, parameter] of unlinkedDimmers) {
    level = Math.max(level, channels[element]?.[parameter]?.level ?? 0);
  }
  return level;
}
