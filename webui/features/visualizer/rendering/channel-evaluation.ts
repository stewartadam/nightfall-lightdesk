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
  /** Output level 0-1 after the relations the fixture itself applies. */
  level: number;
  /**
   * Whether this parameter is a relation master of an emitter (color)
   * channel in its own element, whose brightness it sets through that
   * relation.
   */
  mastersOwnEmitters: boolean;
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
  /** Whether an emitter parameter in the same element follows this one. */
  mastersOwnEmitters: boolean;
  /** Whether this parameter masters or follows any relation. */
  linked: boolean;
}

/**
 * Link targets for every parameter of a fixture, with buffers reused by
 * every evaluation so the render loop does not allocate.
 */
interface CompiledFixture {
  /** Per element, per parameter. */
  parameters: CompiledParameter[][];
  /**
   * Physical dimmers no relation mentions. A profile states what its linked
   * dimmers control; an unlinked dimmer is assumed to master the whole
   * fixture. Unlinked virtual dimmers never reach the fixture.
   */
  unlinkedDimmers: ResolvedRef[];
  /** Evaluation result, per element and parameter. */
  channels: (EvaluatedChannel | undefined)[][];
  /** Channel objects reused for `channels`. */
  pool: EvaluatedChannel[][];
  /** Per element and parameter, whether relations are applied this evaluation. */
  resolved: Uint8Array[];
}

/** Attributes whose parameters emit colored light. */
const EMITTER_ATTRIBUTES = new Set([
  "Red",
  "Green",
  "Blue",
  "White",
  "WarmWhite",
  "CoolWhite",
  "Amber",
  "Cyan",
  "Magenta",
  "Yellow",
  "UV",
]);

/** Returns true for attributes that dim an element. */
function isDimmer(attribute: Attribute): boolean {
  return (
    attribute.type === "Intensity" || attribute.type === "VirtualIntensity"
  );
}

/** Returns true for parameters that emit light of their own color. */
function isEmitter(parameter: ParameterMetadata): boolean {
  return (
    EMITTER_ATTRIBUTES.has(parameter.attribute.type) ||
    Boolean(parameter.functions?.some((fn) => fn.emitter_color))
  );
}

/** Returns true for parameters that occupy no DMX slots. */
function isVirtual(parameter: ParameterMetadata): boolean {
  return parameter.dmx_slots?.type === "Virtual";
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
        mastersOwnEmitters: false,
        linked: relations.some((fnRelations) => fnRelations.length > 0),
      };
    }),
  );
  parameters.forEach((element, elementIndex) => {
    element.forEach((parameter, parameterIndex) => {
      const follower = elements[elementIndex].parameters[parameterIndex];
      for (const relation of parameter.relations.flat()) {
        const [masterElement, masterParameter] = relation.master;
        const master = parameters[masterElement][masterParameter];
        master.linked = true;
        if (masterElement === elementIndex && isEmitter(follower)) {
          master.mastersOwnEmitters = true;
        }
      }
    });
  });
  const unlinkedDimmers: ResolvedRef[] = [];
  elements.forEach((element, elementIndex) => {
    element.parameters.forEach((parameter, parameterIndex) => {
      if (
        isDimmer(parameter.attribute) &&
        !isVirtual(parameter) &&
        !parameters[elementIndex][parameterIndex].linked
      ) {
        unlinkedDimmers.push([elementIndex, parameterIndex]);
      }
    });
  });
  return {
    parameters,
    unlinkedDimmers,
    channels: elements.map((element) =>
      element.parameters.map(() => undefined),
    ),
    pool: elements.map((element, elementIndex) =>
      element.parameters.map((parameter, parameterIndex) => ({
        parameter,
        value: 0,
        dmx: 0,
        fraction: 0,
        physical: 0,
        level: 0,
        mastersOwnEmitters:
          parameters[elementIndex][parameterIndex].mastersOwnEmitters,
      })),
    ),
    resolved: elements.map(
      (element) => new Uint8Array(element.parameters.length),
    ),
  };
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

/**
 * Returns the index of the function active at a channel's DMX value: the
 * first whose range contains it and whose mode master condition holds.
 */
function activeFunctionIndex(
  channel: EvaluatedChannel,
  modeMasters: (ResolvedRef | undefined)[],
  channels: (EvaluatedChannel | undefined)[][],
): number | undefined {
  const functions = channel.parameter.functions ?? [];
  for (let index = 0; index < functions.length; index++) {
    const fn = functions[index];
    if (channel.dmx < fn.dmx_from || channel.dmx > fn.dmx_to) continue;
    const condition = fn.mode_master;
    const masterRef = modeMasters[index];
    if (!condition || !masterRef) return index;
    const masterDmx = channels[masterRef[0]]?.[masterRef[1]]?.dmx ?? 0;
    if (masterDmx >= condition.dmx_from && masterDmx <= condition.dmx_to) {
      return index;
    }
  }
  return undefined;
}

/**
 * Applies the relations the fixture itself evaluates to a channel's level
 * and returns it, resolving masters that follow masters of their own first.
 *
 * Relations involving a virtual channel are the console's and are already
 * part of the output, so only relations between two real channels apply.
 */
function resolveLevel(
  compiled: CompiledFixture,
  elementIndex: number,
  parameterIndex: number,
  depth: number,
): number {
  const channel = compiled.channels[elementIndex]?.[parameterIndex];
  if (!channel) return 0;
  const resolved = compiled.resolved[elementIndex];
  if (resolved[parameterIndex] || !channel.function) return channel.level;
  resolved[parameterIndex] = 1;
  if (isVirtual(channel.parameter)) return channel.level;
  const functionIndex = channel.parameter.functions?.indexOf(channel.function);
  const relations =
    compiled.parameters[elementIndex][parameterIndex].relations[
      functionIndex ?? -1
    ] ?? [];
  for (const { master: masterRef, kind } of relations) {
    const master = compiled.channels[masterRef[0]]?.[masterRef[1]];
    if (!master || isVirtual(master.parameter)) continue;
    if (depth >= MAX_RELATION_DEPTH) break;
    const masterLevel = resolveLevel(
      compiled,
      masterRef[0],
      masterRef[1],
      depth + 1,
    );
    channel.level =
      kind === RelationKind.Multiply
        ? channel.level * masterLevel
        : masterLevel;
  }
  return channel.level;
}

/**
 * Evaluates every parameter of a fixture using precompiled links, filling
 * the compiled fixture's reused buffers.
 */
function evaluate(
  elements: FixtureElement[],
  outputs: (Record<string, number> | undefined)[],
  compiled: CompiledFixture,
): (EvaluatedChannel | undefined)[][] {
  const { channels, pool } = compiled;
  for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
    const output = outputs[elementIndex];
    const parameters = elements[elementIndex].parameters;
    compiled.resolved[elementIndex].fill(0);
    for (let index = 0; index < parameters.length; index++) {
      const parameter = parameters[index];
      const value =
        parameter.attribute.type === "VirtualIntensity"
          ? (output?.VirtualIntensity ?? output?.Intensity)
          : output?.[compiled.parameters[elementIndex][index].key];
      if (value === undefined || parameter.max <= 0) {
        channels[elementIndex][index] = undefined;
        continue;
      }
      const channel = pool[elementIndex][index];
      channel.value = value;
      channel.dmx = Math.round(
        normalizedOutput(parameter, value) * dmxMax(parameter),
      );
      channels[elementIndex][index] = channel;
    }
  }

  // Select functions once every DMX value is known, so mode masters in any
  // element can be read.
  for (let elementIndex = 0; elementIndex < channels.length; elementIndex++) {
    const element = channels[elementIndex];
    for (let index = 0; index < element.length; index++) {
      const channel = element[index];
      if (!channel) continue;
      applyFunction(
        channel,
        activeFunctionIndex(
          channel,
          compiled.parameters[elementIndex][index].modeMasters,
          channels,
        ),
      );
    }
  }

  for (let elementIndex = 0; elementIndex < channels.length; elementIndex++) {
    for (let index = 0; index < channels[elementIndex].length; index++) {
      resolveLevel(compiled, elementIndex, index, 0);
    }
  }
  return channels;
}

/**
 * Evaluates every parameter of a fixture, following mode masters and
 * relations across its elements. Entries are undefined for parameters
 * without output. The result is reused by the next evaluation of the same
 * fixture, so read it before evaluating the fixture again.
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
 * The result is reused by the next evaluation of the same element.
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
