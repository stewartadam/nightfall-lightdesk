// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Evaluation of fixture channel output the way a fixture interprets it.
 *
 * Evaluation runs in the Rust fixture model (`nightfall-fixture-model`)
 * through WebAssembly, the same implementation the console applies relations
 * with. Outputs already carry the relations the console applies (those
 * involving a virtual channel); the model applies the relations between real
 * channels, as the fixture would, then selects each parameter's active
 * function (honouring mode masters) and maps its DMX value through channel
 * sets and DMX profiles.
 *
 * Until the WebAssembly module has loaded, every channel evaluates as having
 * no output; {@link loadFixtureEvaluation} resolves once it can evaluate.
 */

import { getLogger } from "../../../lib/logger";
import {
  loadedWasmBridge,
  loadWasmBridge,
  type WasmBridgeModule,
} from "../../../lib/wasm-module";
import type {
  Attribute,
  FixtureElement,
  ParameterFunction,
  ParameterFunctionSet,
  ParameterMetadata,
} from "../../../types";

const log = getLogger(import.meta.url);

/** A parameter's output as the fixture interprets it. */
export interface EvaluatedChannel {
  /** Parameter metadata. */
  parameter: ParameterMetadata;
  /** Logical output value as reported by the console, in the parameter's native unit. */
  value: number;
  /** DMX value the fixture receives, at the parameter's resolution. */
  dmx: number;
  /** Profile function active at `dmx`, if the parameter declares functions. */
  function?: ParameterFunction;
  /** Index of `function` in the parameter's functions, or -1 without one. */
  functionIndex: number;
  /** Channel set of the active function containing `dmx`. */
  set?: ParameterFunctionSet;
  /** Index of `set` in the active function's sets, or -1 without one. */
  setIndex: number;
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
   * channel in its own element through that emitter's active function, so
   * it sets the emitter's brightness through that relation this evaluation.
   */
  mastersOwnEmitters: boolean;
}

/** Every channel of a fixture after one evaluation. */
export interface FixtureChannels {
  /** Per element and parameter; undefined for parameters without output. */
  channels: (EvaluatedChannel | undefined)[][];
  /**
   * Level of the real dimmers that master no relation, which the visualizer
   * treats as mastering the whole fixture: the brightest of them, 0 when none
   * has output, or undefined when the fixture has none.
   */
  dimmerLevel: number | undefined;
}

/** WASM evaluator of one fixture. */
type ChannelEvaluator = InstanceType<
  WasmBridgeModule["FixtureChannelEvaluator"]
>;

/**
 * A fixture's evaluator with buffers reused by every evaluation, so the
 * render loop does not allocate.
 */
interface CompiledFixture {
  /** Elements the evaluator was built from. */
  elements: FixtureElement[];
  /** Evaluator of the fixture's model. */
  evaluator: ChannelEvaluator;
  /** Values written per parameter into `readings`. */
  stride: number;
  /** Output record key of each parameter, per element. */
  keys: string[][];
  /** Outputs of every parameter in element order, `NaN` without output. */
  outputs: Float64Array;
  /** Readings of every parameter, `stride` values each. */
  readings: Float64Array;
  /** Result of the latest evaluation. */
  result: FixtureChannels;
  /** Channel objects reused for `result`. */
  pool: EvaluatedChannel[][];
}

const compiledFixtures = new WeakMap<FixtureElement[], CompiledFixture>();
const compiledElements = new WeakMap<FixtureElement, CompiledFixture>();
/** Fixtures whose metadata the evaluator rejected, so they are reported once. */
const rejected = new WeakSet<object>();

/** Load of the WebAssembly fixture model, started when this module is imported. */
const loading = loadWasmBridge().then(
  () => undefined,
  (error: unknown) => {
    log.error("Failed to load fixture channel evaluation:", error);
  },
);

/**
 * Resolves once the WebAssembly fixture model has loaded and channels can be
 * evaluated, or once loading has failed and been logged.
 */
export function loadFixtureEvaluation(): Promise<void> {
  return loading;
}

/**
 * Returns whether the WebAssembly fixture model has loaded. Until then every
 * channel evaluates as having no output, so callers that cache evaluated
 * output must re-evaluate once this turns true.
 */
export function isFixtureEvaluationLoaded(): boolean {
  return loadedWasmBridge() !== null;
}

/** Returns the output record key of an attribute. */
export function attributeOutputKey(attribute: Attribute): string {
  return attribute.type === "Custom" ? attribute.data.label : attribute.type;
}

/**
 * Builds the evaluator and buffers for a fixture's elements, or returns
 * undefined while the model is loading or when it rejects the metadata.
 *
 * With `linked` false, mode masters and relations naming other elements are
 * ignored; this evaluates a lone element whose references cannot be followed.
 */
function compile(
  elements: FixtureElement[],
  linked: boolean,
  key: object,
): CompiledFixture | undefined {
  const wasm = loadedWasmBridge();
  if (!wasm || rejected.has(key)) return undefined;
  let evaluator: ChannelEvaluator;
  try {
    evaluator = new wasm.FixtureChannelEvaluator(
      JSON.stringify(elements),
      linked,
    );
  } catch (error) {
    rejected.add(key);
    log.warn("Fixture metadata cannot be evaluated:", error);
    return undefined;
  }
  const stride = wasm.fixture_reading_stride();
  const count = evaluator.parameter_count;
  return {
    elements,
    evaluator,
    stride,
    keys: elements.map((element) =>
      element.parameters.map((parameter) =>
        attributeOutputKey(parameter.attribute),
      ),
    ),
    outputs: new Float64Array(count),
    readings: new Float64Array(count * stride),
    result: {
      channels: elements.map((element) =>
        element.parameters.map(() => undefined),
      ),
      dimmerLevel: undefined,
    },
    pool: elements.map((element) =>
      element.parameters.map((parameter) => ({
        parameter,
        value: 0,
        dmx: 0,
        functionIndex: -1,
        setIndex: -1,
        fraction: 0,
        physical: 0,
        level: 0,
        mastersOwnEmitters: false,
      })),
    ),
  };
}

/** Returns an element's output for a parameter, if it has one. */
function outputValue(
  output: Record<string, number> | undefined,
  parameter: ParameterMetadata,
  key: string,
): number | undefined {
  return parameter.attribute.type === "VirtualIntensity"
    ? (output?.VirtualIntensity ?? output?.Intensity)
    : output?.[key];
}

/**
 * Evaluates `outputs`, one record per element, with a compiled fixture and
 * fills its reused result.
 */
function evaluate(
  compiled: CompiledFixture,
  outputs: (Record<string, number> | undefined)[],
): FixtureChannels {
  const { elements, keys, stride, readings, pool, result } = compiled;
  let offset = 0;
  for (let element = 0; element < elements.length; element++) {
    const parameters = elements[element].parameters;
    for (let index = 0; index < parameters.length; index++) {
      compiled.outputs[offset + index] =
        outputValue(
          outputs[element],
          parameters[index],
          keys[element][index],
        ) ?? Number.NaN;
    }
    offset += parameters.length;
  }

  const dimmerLevel = compiled.evaluator.evaluate(compiled.outputs, readings);
  result.dimmerLevel = Number.isNaN(dimmerLevel) ? undefined : dimmerLevel;

  offset = 0;
  for (let element = 0; element < elements.length; element++) {
    const channels = result.channels[element];
    for (let index = 0; index < channels.length; index++) {
      const base = (offset + index) * stride;
      const dmx = readings[base];
      if (Number.isNaN(dmx)) {
        channels[index] = undefined;
        continue;
      }
      const channel = pool[element][index];
      const functionIndex = readings[base + 1];
      const setIndex = readings[base + 2];
      channel.value = compiled.outputs[offset + index];
      channel.dmx = dmx;
      channel.function =
        functionIndex >= 0
          ? channel.parameter.functions?.[functionIndex]
          : undefined;
      channel.set =
        setIndex >= 0 ? channel.function?.sets?.[setIndex] : undefined;
      channel.functionIndex = channel.function ? functionIndex : -1;
      channel.setIndex = channel.set ? setIndex : -1;
      channel.fraction = readings[base + 3];
      channel.physical = readings[base + 4];
      channel.level = readings[base + 5];
      channel.mastersOwnEmitters = readings[base + 6] === 1;
      channels[index] = channel;
    }
    offset += channels.length;
  }
  return result;
}

/** Returns a result with no output for every parameter of `elements`. */
function unevaluated(elements: FixtureElement[]): FixtureChannels {
  return {
    channels: elements.map((element) =>
      element.parameters.map(() => undefined),
    ),
    dimmerLevel: undefined,
  };
}

/**
 * Evaluates every parameter of a fixture, following mode masters and
 * relations across its elements. The result is reused by the next evaluation
 * of the same fixture, so read it before evaluating the fixture again.
 */
export function evaluateFixtureChannels(
  elements: FixtureElement[],
  outputs: (Record<string, number> | undefined)[],
): FixtureChannels {
  let compiled = compiledFixtures.get(elements);
  if (!compiled) {
    compiled = compile(elements, true, elements);
    if (!compiled) return unevaluated(elements);
    compiledFixtures.set(elements, compiled);
  }
  return evaluate(compiled, outputs);
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
    compiled = compile([element], false, element);
    if (!compiled) return unevaluated([element]).channels[0];
    compiledElements.set(element, compiled);
  }
  return evaluate(compiled, [output]).channels[0];
}
