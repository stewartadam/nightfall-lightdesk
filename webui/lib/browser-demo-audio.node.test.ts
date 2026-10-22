// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

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

/** Capture how the host schedules one run of the decoded buffer. */
class FakeSource {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  offset: number | null = null;
  stopped = false;

  /** Pass the node through like a real audio graph connection. */
  connect<T>(node: T): T {
    return node;
  }

  /** Record the buffer offset playback starts from. */
  start(_when: number, offset: number): void {
    this.offset = offset;
  }

  /** Record that the voice was released. */
  stop(): void {
    this.stopped = true;
  }
}

/** Audio context whose clock is driven by the test instead of an audio device. */
class FakeContext {
  currentTime = 0;
  state = "suspended";
  outputLatency = 0.25;
  baseLatency = 0;
  destination = {};
  sources: FakeSource[] = [];

  /** Unlock output the way a Play gesture does. */
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }

  /** Create and remember a buffer source so tests can inspect it. */
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  /** Create a gain stage for the voice fade. */
  createGain() {
    return { gain: new FakeParam(), connect: () => undefined };
  }
}

/** Build a host on a test clock whose decoding finishes only when `finishDecoding` runs. */
async function createTestHost() {
  const { BrowserDemoAudioHost } = await import("./browser-demo-audio");
  const { browserDemoAudioState } = await import("../state/appStores");
  const context = new FakeContext();
  let nowMs = 10_000;
  let finishDecoding: () => void = () => undefined;
  const host = new BrowserDemoAudioHost(() => nowMs, {
    createContext: () => context as unknown as AudioContext,
    decode: () =>
      new Promise<AudioBuffer>((resolve) => {
        finishDecoding = () => resolve({ duration: 60 } as AudioBuffer);
      }),
  });
  return {
    host,
    context,
    state: () => browserDemoAudioState.get(),
    finishDecoding: () => finishDecoding(),
    /** Advance wall-clock and audio-clock time together. */
    advance(ms: number) {
      nowMs += ms;
      context.currentTime += ms / 1_000;
    },
  };
}

/** A pause at zero remains paused, while stopped and newly loaded audio remains ready. */
test("browser audio distinguishes paused playback at zero from ready media", async (t) => {
  const { host, state, finishDecoding } = await createTestHost();
  // A failed assertion must not leave the state publisher keeping the process alive.
  t.after(() => host.unload());
  const session = host.beginSession();
  const primed = host.prime("timeline", "https://example.test/demo.wav");
  finishDecoding();
  await primed;
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
  const other = host.prime("other", "https://example.test/other.wav");
  finishDecoding();
  await other;
  assert.equal(state().status, "ready");
  host.unload();
});

/**
 * Audio decoded after the engine started joins the engine clock where it is now, with the
 * output latency added so the speakers match the playhead. Inaudible drift is left alone,
 * audible drift restarts the audio on the clock, loops wrap in place without a restart, and
 * a paused seek is where the next start resumes.
 */
test("browser audio follows the engine clock", async (t) => {
  const { host, context, state, finishDecoding, advance } =
    await createTestHost();
  // A failed assertion must not leave the state publisher keeping the process alive.
  t.after(() => host.unload());
  const session = host.beginSession();
  const timeline_uid = "timeline";
  /** Apply a directive carrying a whole-millisecond offset. */
  const directive = (type: "Play" | "Sync" | "Seek", offsetMs: number) =>
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
    );
  const primed = host.prime(timeline_uid, "https://example.test/demo.mp3");
  assert.equal(context.state, "running");

  // Decoding takes 1.5 s after the engine started at 4 s.
  const playing = directive("Play", 4_000);
  advance(1_500);
  finishDecoding();
  await primed;
  await playing;
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0].offset, 5.75);
  assert.equal(state().status, "playing");
  assert.equal(state().positionMs, 5_500);

  advance(1_000);
  await directive("Sync", 6_520);
  assert.equal(context.sources.length, 1);

  // A busy engine falls half a second behind; the audio restarts where the engine is.
  await directive("Sync", 6_000);
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[0].stopped, true);
  assert.equal(context.sources[1].offset, 6.25);

  host.setLoop(timeline_uid, {
    start: { secs: 2, nanos: 0 },
    end: { secs: 8, nanos: 0 },
  });
  assert.deepEqual(
    [
      context.sources[1].loop,
      context.sources[1].loopStart,
      context.sources[1].loopEnd,
    ],
    [true, 2, 8],
  );
  // The loop wraps the audio back to 2.5 s just as the engine restarts from there.
  advance(2_500);
  await directive("Play", 2_500);
  assert.equal(context.sources.length, 2);

  await host.applyDirective({ type: "Pause", data: { timeline_uid } }, session);
  assert.equal(context.sources[1].stopped, true);
  assert.deepEqual(state(), { session, status: "paused", positionMs: 2_500 });
  host.setLoop(timeline_uid, undefined);
  await directive("Seek", 10_000);
  assert.equal(context.sources.length, 2);
  assert.equal(state().positionMs, 10_000);

  await directive("Play", 10_000);
  assert.equal(context.sources[2].offset, 10.25);
  host.unload();
  assert.equal(context.sources[2].stopped, true);
});
