// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AudioTrack } from "./streaming-audio/track";

// One sample per millisecond keeps the arithmetic readable: sample values are positions.
const SAMPLE_RATE = 1_000;
// Samples each fake read returns.
const READ_FRAMES = 250;
// Length of the fake track.
const TRACK_MS = 60_000;

/** Record an automation parameter's latest value without scheduling anything. */
class FakeParam {
  value = 1;

  /** Jump to `value`; scheduling time is irrelevant to these tests. */
  setValueAtTime(value: number): void {
    this.value = value;
  }

  /** Treat ramps as instant so the final level is observable. */
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }

  /** Nothing is scheduled ahead, so there is nothing to cancel. */
  cancelScheduledValues(): void {}
}

/** One scheduled block: when it starts, the samples it holds and when it was stopped. */
class FakeSource {
  buffer: { channels: Float32Array[] } | null = null;
  startTime: number | null = null;
  stopTime: number | null = null;
  onended: (() => void) | null = null;

  /** Constructed for the voice owning gain stage `voice`. */
  constructor(readonly voice: number) {}

  /** Pass the node through like a real audio graph connection. */
  connect<T>(node: T): T {
    return node;
  }

  /** Nothing to release. */
  disconnect(): void {}

  /** Record when the block plays. */
  start(when: number): void {
    this.startTime = when;
  }

  /** Record when the block was cut off. */
  stop(when: number): void {
    this.stopTime = when;
  }

  /** The track position of the block's first sample, since samples hold positions. */
  get firstPositionMs(): number {
    return this.buffer?.channels[0][0] ?? Number.NaN;
  }
}

/** Audio context whose clock is driven by the test instead of an audio device. */
class FakeContext {
  sampleRate = SAMPLE_RATE;
  currentTime = 0;
  state = "suspended";
  outputLatency = 0.25;
  baseLatency = 0;
  destination = {};
  sources: FakeSource[] = [];
  voices = 0;

  /** Unlock output the way a Play gesture does. */
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }

  /** Create and remember a buffer source so tests can inspect it. */
  createBufferSource(): FakeSource {
    const source = new FakeSource(this.voices);
    this.sources.push(source);
    return source;
  }

  /** Allocate a block of samples. */
  createBuffer(channelCount: number, length: number) {
    const channels = Array.from(
      { length: channelCount },
      () => new Float32Array(length),
    );
    return { channels, getChannelData: (index: number) => channels[index] };
  }

  /** Each voice owns one gain stage, so counting them counts voices. */
  createGain() {
    this.voices += 1;
    return {
      gain: new FakeParam(),
      connect: () => undefined,
      disconnect: () => undefined,
    };
  }

  /** Sources created by voice number `voice`, counting from 1. */
  sourcesOf(voice: number): FakeSource[] {
    return this.sources.filter((source) => source.voice === voice);
  }
}

/** A track whose samples equal their position in milliseconds. */
function positionTrack(): AudioTrack {
  return {
    sampleRate: SAMPLE_RATE,
    channelCount: 1,
    durationMs: () => TRACK_MS,
    openReader(startFrame: number) {
      let at = startFrame;
      return {
        read: async () => {
          if (at >= TRACK_MS) return null;
          const length = Math.min(READ_FRAMES, TRACK_MS - at);
          const block = Float32Array.from({ length }, (_, i) => at + i);
          at += length;
          return [block];
        },
        close: () => undefined,
      };
    },
    close: () => undefined,
  };
}

/** Assert two positions match to well under a sample, allowing float rounding. */
function assertNear(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);
}

/** Let pending promise chains, such as a voice decoding its first block, settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Build a host on a test clock whose track opens only when `finishOpening` runs. */
async function createTestHost() {
  const { BrowserDemoAudioHost } = await import("./browser-demo-audio");
  const { browserDemoAudioState } = await import("../state/appStores");
  const context = new FakeContext();
  let nowMs = 10_000;
  let finishOpening: () => void = () => undefined;
  const host = new BrowserDemoAudioHost(() => nowMs, {
    createContext: () => context as unknown as AudioContext,
    open: () =>
      new Promise<AudioTrack>((resolve) => {
        finishOpening = () => resolve(positionTrack());
      }),
  });
  return {
    host,
    context,
    state: () => browserDemoAudioState.get(),
    finishOpening: () => finishOpening(),
    now: () => nowMs,
    /** Advance wall-clock and audio-clock time together. */
    advance(ms: number) {
      nowMs += ms;
      context.currentTime += ms / 1_000;
    },
  };
}

/** A pause at zero remains paused, while stopped and newly loaded audio remains ready. */
test("browser audio distinguishes paused playback at zero from ready media", async (t) => {
  const { host, state, finishOpening } = await createTestHost();
  // A failed assertion must not leave timers keeping the process alive.
  t.after(() => host.unload());
  const session = host.beginSession();
  host.prime("timeline", "https://example.test/demo.wav");
  finishOpening();
  assert.equal(state().status, "ready");
  await host.play("timeline", 0);
  assert.equal(state().status, "playing");
  host.pause("timeline");
  assert.equal(state().positionMs, 0);
  assert.equal(state().status, "paused");
  host.pause("timeline");
  assert.equal(state().status, "paused");
  host.stop("timeline");
  assert.equal(state().status, "ready");
  await host.play("timeline", 0);
  host.beginSession();
  assert.equal(state().status, "unloaded");
  assert.equal(host.currentSession(), session + 1);
  host.prime("other", "https://example.test/other.wav");
  finishOpening();
  assert.equal(state().status, "ready");
  host.unload();
});

/**
 * Audio opened after the engine started joins the engine clock where it is when its
 * first block is decoded, with the output latency added so the speakers match the
 * playhead. Only a few seconds are scheduled ahead. Inaudible drift is left alone,
 * audible drift hands over to a new voice with a crossfade, a loop end inside the
 * scheduled audio restarts it with the wrap scheduled in place, and a paused seek is
 * where the next start resumes.
 */
test("browser audio streams on the engine clock", async (t) => {
  const { host, context, state, finishOpening, advance, now } =
    await createTestHost();
  t.after(() => host.unload());
  const session = host.beginSession();
  const timeline_uid = "timeline";
  /** Apply a directive carrying a whole-millisecond offset, optionally sent earlier. */
  const directive = (
    type: "Play" | "Sync" | "Seek",
    offsetMs: number,
    sentAtMs?: number,
  ) =>
    host.applyDirective(
      {
        type,
        data: {
          timeline_uid,
          offset: {
            secs: Math.floor(offsetMs / 1_000),
            nanos: (offsetMs % 1_000) * 1_000_000,
          },
        },
      },
      session,
      sentAtMs,
    );
  host.prime(timeline_uid, "https://example.test/demo.mp3");
  assert.equal(context.state, "running");

  // Opening takes 1.5 s after the engine started at 4 s.
  const playing = directive("Play", 4_000);
  advance(1_500);
  finishOpening();
  await playing;
  await settle();
  // The first block is scheduled 30 ms out and heard 250 ms after that, when the engine
  // will be at 5.78 s.
  const [first] = context.sourcesOf(1);
  assert.equal(first.startTime, 1.53);
  assert.equal(first.firstPositionMs, 5_780);
  const lastStart = Math.max(
    ...context.sourcesOf(1).map((source) => source.startTime ?? 0),
  );
  assert.ok(lastStart < context.currentTime + 3.5, "only seconds ahead");
  assert.equal(state().status, "playing");
  assertNear(state().positionMs, 5_500);

  advance(1_000);
  await directive("Sync", 6_520);
  assert.equal(context.voices, 1);

  // A Sync that waited 400 ms for a busy main thread still describes the engine clock
  // when it was sent, so audio on that clock keeps playing.
  advance(400);
  await directive("Sync", 6_500, now() - 400);
  assert.equal(context.voices, 1);

  // A busy engine falls behind; a new voice joins where the engine is and the old one
  // fades out exactly as the new one starts.
  await directive("Sync", 6_000);
  await settle();
  assert.equal(context.voices, 2);
  const [rejoined] = context.sourcesOf(2);
  assert.equal(rejoined.firstPositionMs, 6_280);
  for (const source of context.sourcesOf(1)) {
    assert.equal(source.stopTime, (rejoined.startTime ?? 0) + 0.01);
  }

  // A loop ending at 8 s falls inside the audio already scheduled, so playback restarts
  // with the wrap back to 2 s scheduled right after the 8 s mark.
  host.setLoop(timeline_uid, {
    start: { secs: 2, nanos: 0 },
    end: { secs: 8, nanos: 0 },
  });
  await settle();
  assert.equal(context.voices, 3);
  const looped = context.sourcesOf(3);
  const wrap = looped.find((source) => source.firstPositionMs === 2_000);
  assert.ok(wrap, "loop start scheduled");
  const loopStartTime =
    (looped[0].startTime ?? 0) + (8_000 - looped[0].firstPositionMs) / 1_000;
  assert.ok(Math.abs((wrap.startTime ?? 0) - loopStartTime) < 1e-9);
  // The engine wraps back to 2.5 s just as the audio does, so nothing restarts.
  advance(2_500);
  await directive("Play", 2_500);
  assert.equal(context.voices, 3);

  // Pausing keeps the heard position, which followed the wrap.
  await host.applyDirective({ type: "Pause", data: { timeline_uid } }, session);
  assert.ok(looped.every((source) => source.stopTime !== null));
  assert.equal(state().status, "paused");
  assertNear(state().positionMs, 2_500);
  host.setLoop(timeline_uid, undefined);
  await directive("Seek", 10_000);
  assert.equal(context.voices, 3);
  assert.equal(state().positionMs, 10_000);

  await directive("Play", 10_000);
  await settle();
  assert.equal(context.sourcesOf(4)[0].firstPositionMs, 10_280);
  host.unload();
  assert.ok(context.sourcesOf(4).every((source) => source.stopTime !== null));
});

/** A loop end beyond the scheduled audio is applied in place without a restart. */
test("browser audio applies a distant loop without restarting", async (t) => {
  const { host, context, finishOpening } = await createTestHost();
  t.after(() => host.unload());
  host.beginSession();
  host.prime("timeline", "https://example.test/demo.mp3");
  finishOpening();
  await host.play("timeline", 0);
  await settle();
  host.setLoop("timeline", {
    start: { secs: 1, nanos: 0 },
    end: { secs: 30, nanos: 0 },
  });
  await settle();
  assert.equal(context.voices, 1);
});

/**
 * Clearing a loop restarts playback when the reader has already wrapped back to the loop
 * start for the next block, even though that block is not scheduled yet.
 */
test("browser audio restarts when a prepared loop wrap is cleared", async (t) => {
  const { host, context, finishOpening } = await createTestHost();
  t.after(() => host.unload());
  host.beginSession();
  host.prime("timeline", "https://example.test/demo.mp3");
  finishOpening();
  // Scheduling stops three seconds ahead, right after the block ending at the loop end.
  host.setLoop("timeline", {
    start: { secs: 1, nanos: 0 },
    end: { secs: 3, nanos: 250_000_000 },
  });
  await host.play("timeline", 0);
  await settle();
  assert.equal(context.sourcesOf(1).at(-1)?.firstPositionMs, 3_000);
  host.setLoop("timeline", undefined);
  await settle();
  assert.equal(context.voices, 2);
});

/** A pause while a seek is still joining keeps the seek target, not the old position. */
test("browser audio pauses at a seek target that has not started yet", async (t) => {
  const { host, state, finishOpening } = await createTestHost();
  t.after(() => host.unload());
  host.beginSession();
  host.prime("timeline", "https://example.test/demo.mp3");
  finishOpening();
  await host.play("timeline", 0);
  await settle();
  host.seek("timeline", 30_000);
  host.pause("timeline");
  assertNear(state().positionMs, 30_000);
});
