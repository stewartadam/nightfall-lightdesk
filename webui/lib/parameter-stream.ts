// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Rebuilds parameter state from the backend's numbered stream of keyframes and deltas.
 *
 * The backend numbers every `ParameterState` frame. A keyframe carries every slot; a delta carries
 * only changed slots and is valid solely on top of the frame numbered one before it. This stream
 * applies each frame as it arrives and refuses deltas after a gap until the next keyframe. A
 * verifiable keyframe also lists the slots that changed in its frame, so the stream can check that
 * the state it rebuilt plus those changes equals the keyframe, and count any drift between engine
 * and UI instead of letting it go unnoticed.
 */

import type { ParameterLayout, ParameterStateFrame } from "../types";
import { getLogger } from "./logger";
import type { PackedParameterState } from "./parameter-state-transfer";

const log = getLogger(import.meta.url);

/**
 * Update module that asks the backend for a keyframe on its next frame
 * (`PARAMETER_KEYFRAME_REQUEST_MODULE` in crates/fixtures/src/parameter_state.rs).
 */
export const PARAMETER_KEYFRAME_REQUEST_MODULE = "ParameterKeyframeRequest";

/** What happened to one frame handed to {@link ParameterStream.apply}. */
export type ParameterFrameOutcome =
  /** The frame updated the rebuilt state. */
  | "applied"
  /** A delta could not be applied because earlier frames are missing; a keyframe is needed. */
  | "gap"
  /** The frame belongs to another layout or is malformed, and was ignored. */
  | "discarded";

/** Cumulative counters describing the health of the parameter stream. */
export interface ParameterStreamStats {
  keyframes: number;
  deltas: number;
  /** Times the stream lost its place and started waiting for a keyframe. */
  gaps: number;
  /** Frames ignored for another layout, a malformed payload, or while waiting for a keyframe. */
  discarded: number;
  /** Verifiable keyframes the rebuilt state was checked against. */
  verifiedKeyframes: number;
  /** Verifiable keyframes that disagreed with the rebuilt state. */
  driftedKeyframes: number;
  /** Output slots that disagreed across all drifted keyframes. */
  driftedSlots: number;
}

/** Assertion buffers of the rebuilt state, in the frame's packed shape. */
interface StreamAssertions {
  absoluteCount: number;
  slots: Uint32Array;
  kinds: Uint8Array;
  values: Float32Array;
}

const EMPTY_ASSERTIONS: StreamAssertions = {
  absoluteCount: 0,
  slots: new Uint32Array(0),
  kinds: new Uint8Array(0),
  values: new Float32Array(0),
};

/** Copies a decoded byte string into its own aligned buffer so it can back a typed array. */
function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Copies `bytes` into `f32`s, or returns `undefined` when its length is not a whole number of them.
 */
export function floats(bytes: Uint8Array): Float32Array | undefined {
  return bytes.byteLength % 4 === 0
    ? new Float32Array(ownedBuffer(bytes))
    : undefined;
}

/**
 * Copies `bytes` into `u32`s, or returns `undefined` when its length is not a whole number of them.
 */
export function words(bytes: Uint8Array): Uint32Array | undefined {
  return bytes.byteLength % 4 === 0
    ? new Uint32Array(ownedBuffer(bytes))
    : undefined;
}

/** Returns the number of slots a layout defines across all fixtures and elements. */
function layoutSlotCount(layout: ParameterLayout): number {
  let count = 0;
  for (const fixture of layout.fixtures) {
    for (const attributes of fixture.elements) count += attributes.length;
  }
  return count;
}

/**
 * Decodes the assertion buffers a frame carries, or returns `undefined` when they disagree in
 * length or name a slot outside the layout.
 */
function decodeAssertions(
  frame: ParameterStateFrame,
  slotCount: number,
): StreamAssertions | undefined {
  const slots = words(frame.assertion_slots);
  const values = floats(frame.assertion_values);
  const kinds = frame.assertion_kinds.slice();
  if (
    !slots ||
    !values ||
    slots.length !== kinds.length ||
    slots.length !== values.length ||
    frame.absolute_count > slots.length ||
    slots.some((slot) => slot >= slotCount)
  ) {
    return undefined;
  }
  return { absoluteCount: frame.absolute_count, slots, kinds, values };
}

/**
 * Parameter state rebuilt from the backend's numbered frames for the current layout.
 *
 * State exists only between a keyframe and the next gap, layout change or invalidation; until
 * then {@link takePacked} has nothing to deliver, so the main thread keeps showing the last
 * complete state rather than a partially updated one.
 *
 * A keyframe is kept as received and only copied into typed arrays when a delta builds on it or a
 * pull delivers it, so keyframes superseded before either happens cost no copies.
 */
export class ParameterStream {
  private layoutId: number | null = null;
  private slotCount = 0;
  /** Latest keyframe, not yet copied into `output` and `assertions`. */
  private pendingKeyframe: ParameterStateFrame | null = null;
  /** Output of every slot, valid only while no keyframe is pending. */
  private output: Float32Array | null = null;
  private assertions: StreamAssertions = EMPTY_ASSERTIONS;
  private lastSeq: number | null = null;
  private dirty = false;
  readonly stats: ParameterStreamStats = {
    keyframes: 0,
    deltas: 0,
    gaps: 0,
    discarded: 0,
    verifiedKeyframes: 0,
    driftedKeyframes: 0,
    driftedSlots: 0,
  };

  /**
   * Adopts the slot order later frames are indexed by. A different layout id discards the
   * rebuilt state, since its slots now mean other parameters; the backend follows every layout
   * with a keyframe.
   */
  setLayout(layout: ParameterLayout): void {
    if (layout.layout_id === this.layoutId) return;
    this.layoutId = layout.layout_id;
    this.slotCount = layoutSlotCount(layout);
    this.desync();
  }

  /**
   * Forgets the layout and rebuilt state, for a new connection or a resync, after which frames
   * are ignored until the next layout arrives.
   */
  invalidate(): void {
    this.layoutId = null;
    this.slotCount = 0;
    this.desync();
  }

  /** Whether rebuilt state changed since the last {@link takePacked}. */
  get pending(): boolean {
    return this.dirty;
  }

  /**
   * Applies one frame in arrival order. Keyframes always apply to the current layout; a delta
   * applies only when it directly follows the last applied frame, and otherwise drops the
   * rebuilt state and reports a gap so the caller can ask for a keyframe.
   */
  apply(frame: ParameterStateFrame): ParameterFrameOutcome {
    if (this.layoutId === null || frame.layout_id !== this.layoutId) {
      this.stats.discarded++;
      return "discarded";
    }
    return frame.keyframe ? this.applyKeyframe(frame) : this.applyDelta(frame);
  }

  /**
   * Returns the rebuilt state when it changed since the last call, in buffers the caller owns
   * and may transfer, or `undefined` when there is nothing new to deliver.
   */
  takePacked(): PackedParameterState | undefined {
    if (!this.dirty || this.layoutId === null) return undefined;
    const output = this.materialize();
    if (!output) return undefined;
    this.dirty = false;
    return {
      layoutId: this.layoutId,
      output: output.slice(),
      absoluteCount: this.assertions.absoluteCount,
      assertionSlots: this.assertions.slots.slice(),
      assertionKinds: this.assertions.kinds.slice(),
      assertionValues: this.assertions.values.slice(),
    };
  }

  /**
   * Adopts a keyframe as the rebuilt state, first checking a verifiable one that directly follows
   * the last applied frame for drift. Buffers are validated by length here and copied later.
   */
  private applyKeyframe(frame: ParameterStateFrame): ParameterFrameOutcome {
    if (
      frame.output.byteLength !== this.slotCount * 4 ||
      frame.changed_slots.byteLength % 4 !== 0
    ) {
      log.error("Discarding malformed parameter keyframe", {
        layoutId: frame.layout_id,
        seq: frame.seq,
      });
      this.stats.discarded++;
      return "discarded";
    }
    if (frame.verifiable && this.follows(frame.seq)) this.verify(frame);
    this.pendingKeyframe = frame;
    this.output = null;
    this.lastSeq = frame.seq;
    this.dirty = true;
    this.stats.keyframes++;
    return "applied";
  }

  /** Writes a delta's changed slots, or reports a gap when it does not follow the last frame. */
  private applyDelta(frame: ParameterStateFrame): ParameterFrameOutcome {
    if (!this.follows(frame.seq)) {
      this.loseSync(frame.seq);
      return "gap";
    }
    const output = this.materialize();
    const slots = words(frame.changed_slots);
    const values = floats(frame.output);
    const assertions = frame.assertions_included
      ? decodeAssertions(frame, this.slotCount)
      : this.assertions;
    if (
      !output ||
      !slots ||
      !values ||
      slots.length !== values.length ||
      !assertions ||
      slots.some((slot) => slot >= this.slotCount)
    ) {
      log.error("Parameter delta is malformed; waiting for a keyframe", {
        layoutId: frame.layout_id,
        seq: frame.seq,
      });
      this.loseSync(frame.seq);
      return "gap";
    }
    for (let i = 0; i < slots.length; i++) output[slots[i]] = values[i];
    this.assertions = assertions;
    this.lastSeq = frame.seq;
    this.dirty = true;
    this.stats.deltas++;
    return "applied";
  }

  /**
   * Returns the full output, copying a pending keyframe into typed arrays first, or `null` when
   * there is no state or the pending keyframe turned out to be malformed.
   */
  private materialize(): Float32Array | null {
    const frame = this.pendingKeyframe;
    if (!frame) return this.output;
    const output = floats(frame.output);
    const assertions = decodeAssertions(frame, this.slotCount);
    if (!output || !assertions) {
      log.error("Parameter keyframe is malformed; waiting for another", {
        layoutId: frame.layout_id,
        seq: frame.seq,
      });
      this.stats.discarded++;
      this.desync();
      return null;
    }
    this.pendingKeyframe = null;
    this.output = output;
    this.assertions = assertions;
    return output;
  }

  /** Returns whether `seq` is the frame directly after the last applied one. */
  private follows(seq: number): boolean {
    return this.lastSeq !== null && seq === (this.lastSeq + 1) >>> 0;
  }

  /**
   * Checks that the rebuilt state with a verifiable keyframe's listed changes applied equals the
   * keyframe, counting and logging any slot that differs. A difference means engine and UI
   * disagreed without a detected gap.
   */
  private verify(frame: ParameterStateFrame): void {
    const current = this.materialize();
    const changed = words(frame.changed_slots);
    if (!current || !changed) return;
    const keyframe = new Uint32Array(ownedBuffer(frame.output));
    const rebuilt = new Uint32Array(
      current.buffer,
      current.byteOffset,
      current.length,
    );
    for (const slot of changed) {
      if (slot < rebuilt.length) rebuilt[slot] = keyframe[slot];
    }
    let driftedSlots = 0;
    for (let slot = 0; slot < keyframe.length; slot++) {
      if (rebuilt[slot] !== keyframe[slot]) driftedSlots++;
    }
    this.stats.verifiedKeyframes++;
    if (driftedSlots === 0) return;
    this.stats.driftedKeyframes++;
    this.stats.driftedSlots += driftedSlots;
    log.warn("Parameter keyframe disagreed with the rebuilt state", {
      layoutId: this.layoutId,
      seq: frame.seq,
      driftedSlots,
    });
  }

  /** Drops the rebuilt state after a missed or unusable frame, counting the gap once. */
  private loseSync(seq: number): void {
    if (this.lastSeq !== null) {
      this.stats.gaps++;
      log.debug("Parameter stream gap; waiting for a keyframe", {
        layoutId: this.layoutId,
        expectedSeq: (this.lastSeq + 1) >>> 0,
        seq,
      });
    } else {
      this.stats.discarded++;
    }
    this.desync();
  }

  /** Clears the rebuilt state so nothing is delivered until the next keyframe. */
  private desync(): void {
    this.pendingKeyframe = null;
    this.output = null;
    this.assertions = EMPTY_ASSERTIONS;
    this.lastSeq = null;
    this.dirty = false;
  }
}
