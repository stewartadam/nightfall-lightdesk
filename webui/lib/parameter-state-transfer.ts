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
  let elementIndex = 0;
  const fixtures = layout.fixtures.map((fixture) => {
    for (const attributes of fixture.elements) {
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
    slotKeys,
    slotElements: Uint32Array.from(slotElementList),
    assertionKinds,
  };
}

/**
 * Restores per-fixture parameter state from values frames, using the most recent layout the
 * backend published on the same stream.
 */
export class ParameterStateDecoder {
  private layout: DecodedLayout | null = null;

  /** Adopts the slot order that subsequent values frames are indexed by. */
  setLayout(layout: ParameterLayout): void {
    this.layout = decodeLayout(layout);
  }

  /**
   * Rebuilds the per-fixture state of one values frame, or returns `undefined` when the frame
   * belongs to a layout other than the current one.
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

    const elements: FixtureParameterState["parameters"] = [];
    const states = layout.fixtures.map(({ fixtureUid, elementCount }) => {
      const parameters: FixtureParameterState["parameters"] = [];
      for (let i = 0; i < elementCount; i++) {
        const element = { output: {}, absolute: {}, relative: {} };
        parameters.push(element);
        elements.push(element);
      }
      return { fixture_uid: fixtureUid, parameters };
    });

    const { output } = packed;
    for (let slot = 0; slot < output.length; slot++) {
      const value = output[slot];
      if (Number.isNaN(value)) continue;
      setAttribute(
        elements[layout.slotElements[slot]].output,
        layout.slotKeys[slot],
        value,
      );
    }

    const { assertionSlots, assertionKinds, assertionValues } = packed;
    for (let i = 0; i < assertionSlots.length; i++) {
      const slot = assertionSlots[i];
      const kind = layout.assertionKinds[assertionKinds[i]];
      if (slot >= layout.slotCount || !kind) continue;
      const element = elements[layout.slotElements[slot]];
      setAttribute(
        i < packed.absoluteCount ? element.absolute : element.relative,
        layout.slotKeys[slot],
        {
          type: kind.type,
          data: { [kind.field]: assertionValues[i] },
        } as ParameterValue,
      );
    }
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
