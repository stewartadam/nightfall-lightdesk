// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ParameterLayout, ParameterValue } from "../types";
import { getLogger } from "./logger";
import type { AnyWsMessage, FixtureParameterState } from "./ws/types";

const log = getLogger(import.meta.url);

/**
 * Parameter state the worker rebuilt from the frame stream, in typed arrays it can transfer to
 * the main thread without cloning.
 */
export interface PackedParameterState {
  layoutId: number;
  output: Float32Array;
  absoluteCount: number;
  assertionSlots: Uint32Array;
  assertionKinds: Uint8Array;
  assertionValues: Float32Array;
}

type ParameterValueType = ParameterValue["type"];

/**
 * Numeric field each assertion variant carries. Keyed by every variant so a new
 * backend variant fails type checking here instead of decoding incorrectly.
 */
const PARAMETER_VALUE_FIELDS: Record<ParameterValueType, "value" | "offset"> = {
  Absolute: "value",
  AbsolutePercent: "value",
  Relative: "offset",
  RelativePercent: "offset",
};
/** Variant lookup for backend-provided names, immune to inherited object keys. */
const PARAMETER_VALUE_FIELD_BY_VARIANT = new Map<string, "value" | "offset">(
  Object.entries(PARAMETER_VALUE_FIELDS),
);

/** Preserves normal object shapes while treating imported prototype-like names as data. */
function setAttribute<T>(
  target: Record<string, T>,
  name: string,
  value: T,
): void {
  if (name === "__proto__") {
    Object.defineProperty(target, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[name] = value;
  }
}

/** Returns the buffers that move to the main thread with a packed values frame. */
export function parameterStateTransfers(
  packed: PackedParameterState,
): ArrayBuffer[] {
  return [
    packed.output.buffer as ArrayBuffer,
    packed.assertionSlots.buffer as ArrayBuffer,
    packed.assertionKinds.buffer as ArrayBuffer,
    packed.assertionValues.buffer as ArrayBuffer,
  ];
}

/** Slot lookups derived once per layout so each frame only walks numeric arrays. */
interface DecodedLayout {
  layoutId: number;
  slotCount: number;
  /** Fixture UID and element count of each fixture, in slot order. */
  fixtures: { fixtureUid: string; elementCount: number }[];
  /** First slot of each fixture, followed by the slot count, so fixture `f` owns `[f, f + 1)`. */
  fixtureSlotStarts: Uint32Array;
  /** First element index of each fixture across all fixtures' elements. */
  fixtureElementStarts: Uint32Array;
  /** First slot of each element, followed by the slot count, so element `e` owns `[e, e + 1)`. */
  elementSlotStarts: Uint32Array;
  /** Attribute key of each slot. */
  slotKeys: string[];
  /** Index of each slot's element across all fixtures' elements. */
  slotElements: Uint32Array;
  /** Variant and payload field of each assertion kind code; unknown variants are absent. */
  assertionKinds: (
    | { type: ParameterValueType; field: "value" | "offset" }
    | undefined
  )[];
}

/** Derives slot lookups from a layout, leaving out assertion variants this client does not know. */
function decodeLayout(layout: ParameterLayout): DecodedLayout {
  const slotKeys: string[] = [];
  const slotElementList: number[] = [];
  const fixtureSlotStarts = new Uint32Array(layout.fixtures.length + 1);
  const fixtureElementStarts = new Uint32Array(layout.fixtures.length);
  const elementSlotStartList: number[] = [];
  let elementIndex = 0;
  const fixtures = layout.fixtures.map((fixture, fixtureIndex) => {
    fixtureSlotStarts[fixtureIndex] = slotKeys.length;
    fixtureElementStarts[fixtureIndex] = elementIndex;
    for (const attributes of fixture.elements) {
      elementSlotStartList.push(slotKeys.length);
      for (const key of attributes) {
        slotKeys.push(key);
        slotElementList.push(elementIndex);
      }
      elementIndex++;
    }
    return {
      fixtureUid: fixture.fixture_uid,
      elementCount: fixture.elements.length,
    };
  });
  fixtureSlotStarts[layout.fixtures.length] = slotKeys.length;
  elementSlotStartList.push(slotKeys.length);
  const assertionKinds = layout.assertion_variants.map((variant) => {
    const field = PARAMETER_VALUE_FIELD_BY_VARIANT.get(variant);
    if (!field) {
      log.error("Ignoring unknown parameter assertion variant", { variant });
      return undefined;
    }
    return { type: variant as ParameterValueType, field };
  });
  return {
    layoutId: layout.layout_id,
    slotCount: slotKeys.length,
    fixtures,
    fixtureSlotStarts,
    fixtureElementStarts,
    elementSlotStarts: Uint32Array.from(elementSlotStartList),
    slotKeys,
    slotElements: Uint32Array.from(slotElementList),
    assertionKinds,
  };
}

type ElementState = FixtureParameterState["parameters"][number];
type AssertionRecord = ElementState["absolute"];

/** Per-element assertion records decoded from one frame, indexed like the layout's elements. */
interface DecodedAssertions {
  absolute: AssertionRecord[];
  relative: AssertionRecord[];
}

/** The last frame a decoder unpacked, which the next frame is compared against. */
interface DecodedFrame {
  layoutId: number;
  packed: PackedParameterState;
  /** Output bits of `packed`, so NaN payloads and signed zeros compare exactly. */
  outputBits: Uint32Array;
  states: FixtureParameterState[];
}

/** Views a float array's bits, so comparisons see every change the backend sent. */
function floatBits(values: Float32Array): Uint32Array {
  return new Uint32Array(values.buffer, values.byteOffset, values.length);
}

/** Returns whether two typed arrays hold the same elements. */
function typedArraysEqual(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Returns whether two frames carry the same assertions in the same order. */
function assertionsEqual(
  left: PackedParameterState,
  right: PackedParameterState,
): boolean {
  return (
    left.absoluteCount === right.absoluteCount &&
    typedArraysEqual(left.assertionSlots, right.assertionSlots) &&
    typedArraysEqual(left.assertionKinds, right.assertionKinds) &&
    typedArraysEqual(
      floatBits(left.assertionValues),
      floatBits(right.assertionValues),
    )
  );
}

/** Returns whether any slot in `[start, end)` differs between two frames' output bits. */
function slotsDiffer(
  previous: Uint32Array,
  next: Uint32Array,
  start: number,
  end: number,
): boolean {
  for (let slot = start; slot < end; slot++) {
    if (previous[slot] !== next[slot]) return true;
  }
  return false;
}

/** Returns the payload number of an assertion, whichever field its variant uses. */
function assertionNumber(value: ParameterValue): number | undefined {
  const field = PARAMETER_VALUE_FIELD_BY_VARIANT.get(value.type);
  return field && (value.data as Record<string, number>)[field];
}

/** Returns whether two assertion records hold the same variants and payloads per attribute. */
function assertionRecordsEqual(
  left: AssertionRecord,
  right: AssertionRecord,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if (Object.getOwnPropertyDescriptor(right, key) === undefined) return false;
    const leftValue = left[key];
    const rightValue = right[key];
    if (
      leftValue.type !== rightValue.type ||
      !Object.is(assertionNumber(leftValue), assertionNumber(rightValue))
    ) {
      return false;
    }
  }
  return true;
}

/** Decodes every assertion of a frame into per-element absolute and relative records. */
function decodeAssertions(
  layout: DecodedLayout,
  packed: PackedParameterState,
): DecodedAssertions {
  const elementCount = layout.elementSlotStarts.length - 1;
  const absolute: AssertionRecord[] = [];
  const relative: AssertionRecord[] = [];
  for (let i = 0; i < elementCount; i++) {
    absolute.push({});
    relative.push({});
  }
  const { assertionSlots, assertionKinds, assertionValues } = packed;
  for (let i = 0; i < assertionSlots.length; i++) {
    const slot = assertionSlots[i];
    const kind = layout.assertionKinds[assertionKinds[i]];
    if (slot >= layout.slotCount || !kind) continue;
    const element = layout.slotElements[slot];
    setAttribute(
      (i < packed.absoluteCount ? absolute : relative)[element],
      layout.slotKeys[slot],
      {
        type: kind.type,
        data: { [kind.field]: assertionValues[i] },
      } as ParameterValue,
    );
  }
  return { absolute, relative };
}

/** Decodes the output record of element `element`, leaving out slots without a value. */
function decodeElementOutput(
  layout: DecodedLayout,
  output: Float32Array,
  element: number,
): ElementState["output"] {
  const record: ElementState["output"] = {};
  const end = layout.elementSlotStarts[element + 1];
  for (let slot = layout.elementSlotStarts[element]; slot < end; slot++) {
    const value = output[slot];
    if (Number.isNaN(value)) continue;
    setAttribute(record, layout.slotKeys[slot], value);
  }
  return record;
}

/**
 * Restores per-fixture parameter state from values frames, using the most recent layout the
 * backend published on the same stream.
 *
 * Fixtures whose slots and assertions did not change since the previous frame keep their
 * previous state objects, as do unchanged output and assertion records of a changed fixture, so
 * consumers can skip unchanged fixtures by identity. Returned state is never mutated afterwards.
 */
export class ParameterStateDecoder {
  private layout: DecodedLayout | null = null;
  private previous: DecodedFrame | null = null;

  /** Adopts the slot order that subsequent values frames are indexed by. */
  setLayout(layout: ParameterLayout): void {
    this.layout = decodeLayout(layout);
    this.previous = null;
  }

  /**
   * Rebuilds the per-fixture state of one values frame, or returns `undefined` when the frame
   * belongs to a layout other than the current one. The decoder keeps `packed` to compare the
   * next frame against, so the caller must not modify it afterwards.
   */
  unpack(packed: PackedParameterState): FixtureParameterState[] | undefined {
    const layout = this.layout;
    if (
      !layout ||
      packed.layoutId !== layout.layoutId ||
      packed.output.length !== layout.slotCount
    ) {
      log.debug("Dropping parameter values for an unknown layout", {
        layoutId: packed.layoutId,
        currentLayoutId: layout?.layoutId,
      });
      return undefined;
    }

    const previous = this.previous;
    const outputBits = floatBits(packed.output);
    const assertions =
      previous && assertionsEqual(previous.packed, packed)
        ? null
        : decodeAssertions(layout, packed);
    const states = layout.fixtures.map(
      ({ fixtureUid, elementCount }, fixtureIndex): FixtureParameterState => {
        const previousState = previous?.states[fixtureIndex];
        const outputChanged =
          !previous ||
          slotsDiffer(
            previous.outputBits,
            outputBits,
            layout.fixtureSlotStarts[fixtureIndex],
            layout.fixtureSlotStarts[fixtureIndex + 1],
          );
        if (previousState && !outputChanged && !assertions) {
          return previousState;
        }

        const elementStart = layout.fixtureElementStarts[fixtureIndex];
        let unchanged = previousState !== undefined && !outputChanged;
        const parameters: ElementState[] = [];
        for (let i = 0; i < elementCount; i++) {
          const element = elementStart + i;
          const previousElement = previousState?.parameters[i];
          const output =
            previousElement &&
            previous &&
            !(
              outputChanged &&
              slotsDiffer(
                previous.outputBits,
                outputBits,
                layout.elementSlotStarts[element],
                layout.elementSlotStarts[element + 1],
              )
            )
              ? previousElement.output
              : decodeElementOutput(layout, packed.output, element);
          let absolute = previousElement?.absolute ?? {};
          let relative = previousElement?.relative ?? {};
          if (assertions) {
            const nextAbsolute = assertions.absolute[element];
            const nextRelative = assertions.relative[element];
            if (
              !previousElement ||
              !assertionRecordsEqual(absolute, nextAbsolute)
            ) {
              absolute = nextAbsolute;
              unchanged = false;
            }
            if (
              !previousElement ||
              !assertionRecordsEqual(relative, nextRelative)
            ) {
              relative = nextRelative;
              unchanged = false;
            }
          }
          parameters.push({
            output,
            absolute,
            relative,
          });
        }
        return unchanged && previousState
          ? previousState
          : { fixture_uid: fixtureUid, parameters };
      },
    );
    this.previous = { layoutId: layout.layoutId, packed, outputBits, states };
    return states;
  }
}

/** One websocket payload the runtime worker queued for the main thread. */
export interface WorkerQueuedMessage {
  data?: AnyWsMessage;
  packedParameters?: PackedParameterState;
  postedAtMs?: unknown;
  deliveryMessageId?: unknown;
}

/** Returns whether a queued worker message carries a packed parameter values frame. */
export function carriesParameterState(message: unknown): boolean {
  return (
    (message as WorkerQueuedMessage | undefined)?.packedParameters !== undefined
  );
}

/**
 * Returns the websocket message a queued worker message delivers. Layout messages update
 * `decoder` and deliver nothing; packed values frames are unpacked against that layout.
 */
export function queuedWorkerMessageData(
  message: WorkerQueuedMessage,
  decoder: ParameterStateDecoder,
): AnyWsMessage | undefined {
  if (message.packedParameters) {
    const data = decoder.unpack(message.packedParameters);
    return data && { type: "ParameterState", data };
  }
  if (message.data?.type === "ParameterLayout") {
    decoder.setLayout(message.data.data);
    return undefined;
  }
  return message.data;
}
