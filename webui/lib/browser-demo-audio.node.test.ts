// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

/** Model media events without advancing the media clock or requiring an audio device. */
class StationaryAudio extends EventTarget {
  currentTime = 0;
  duration = 4;
  paused = true;
  src = "";
  volume = 1;
  preload = "";

  /** Keep the media clock stationary while loading a source. */
  load(): void {}

  /** Dispatch the same playback event as a media element without advancing time. */
  async play(): Promise<void> {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }

  /** Emit a pause event only when playback was actually running. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  /** Drop the source when the host unloads the timeline. */
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
}

/** A pause at zero remains paused, while stopped and newly loaded media remain ready. */
test("browser audio distinguishes paused playback at zero from ready media", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: StationaryAudio,
  });
  try {
    const { BrowserDemoAudioHost } = await import("./browser-demo-audio");
    const { browserDemoAudioState } = await import("../state/appStores");
    const host = new BrowserDemoAudioHost();
    const session = host.beginSession();
    await host.prime("timeline", "https://example.test/demo.wav");
    assert.equal(browserDemoAudioState.get().status, "ready");
    await host.play("timeline", 0);
    assert.equal(browserDemoAudioState.get().status, "playing");
    host.pause("timeline");
    assert.equal(browserDemoAudioState.get().positionMs, 0);
    assert.equal(browserDemoAudioState.get().status, "paused");
    host.pause("timeline");
    assert.equal(browserDemoAudioState.get().status, "paused");
    host.stop("timeline");
    assert.equal(browserDemoAudioState.get().status, "ready");
    await host.play("timeline", 0);
    host.beginSession();
    assert.equal(browserDemoAudioState.get().status, "unloaded");
    assert.equal(host.currentSession(), session + 1);
    await host.prime("other", "https://example.test/other.wav");
    assert.equal(browserDemoAudioState.get().status, "ready");
    host.unload();
  } finally {
    if (previous) Object.defineProperty(globalThis, "Audio", previous);
    else Reflect.deleteProperty(globalThis, "Audio");
  }
});

/** Model a phone media element whose `play()` resolves only once the test releases it. */
class BufferingAudio extends StationaryAudio {
  override duration = 60;
  seeking = false;
  playbackRate = 1;
  readyState = 4;
  muted = false;
  private releasePlay: (() => void) | null = null;

  /** Hold playback start until {@link finishBuffering} runs, like a network fetch. */
  override play(): Promise<void> {
    return new Promise((resolve) => {
      this.releasePlay = () => {
        this.paused = false;
        this.dispatchEvent(new Event("play"));
        resolve();
      };
    });
  }

  /** Let the pending `play()` start the media clock. */
  finishBuffering(): void {
    this.releasePlay?.();
    this.releasePlay = null;
  }
}

/**
 * Media that resumes behind its seek target, as Safari and iOS do while rebuffering, is
 * seeked again ahead of the engine clock by the shortfall just observed, and the learned
 * lead carries over to later seeks and starts. Small drift and Sync reports from an engine
 * running slower than real time are eased out through playback speed, playback that stalls
 * far behind is seeked back onto the clock, at the loop end the media waits for the engine
 * to restart it, and once paused it is left alone at normal speed.
 */
test("browser audio follows the engine clock when the media starts late", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: BufferingAudio,
  });
  try {
    const { BrowserDemoAudioHost } = await import("./browser-demo-audio");
    let nowMs = 10_000;
    const host = new BrowserDemoAudioHost(() => nowMs);
    const element = host.element as unknown as BufferingAudio;
    const session = host.beginSession();
    const timeline_uid = "timeline";
    /** Report media at `seconds` after `elapsedMs` of wall-clock time. */
    const mediaAt = (elapsedMs: number, seconds: number) => {
      nowMs += elapsedMs;
      element.currentTime = seconds;
      element.dispatchEvent(new Event("timeupdate"));
    };
    const unlocked = host.prime(timeline_uid, "https://example.test/demo.mp3");
    element.finishBuffering();
    await unlocked;
    assert.equal(element.muted, false);

    // The phone spends 1.5 s buffering before sound starts at the requested 4 s.
    const playing = host.applyDirective(
      { type: "Play", data: { timeline_uid, offset: { secs: 4, nanos: 0 } } },
      session,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    nowMs += 1_500;
    element.finishBuffering();
    await playing;
    assert.equal(element.currentTime, 4);

    // Once media advances, the 1.5 s shortfall becomes the lead for a follow-up seek.
    mediaAt(250, 4.25);
    assert.equal(element.currentTime, 7.25);
    assert.equal(element.playbackRate, 1);

    // That seek rebuffers for only 1 s and lands 0.5 s ahead, so the lead shrinks to 1 s.
    mediaAt(1_000, 7.25);
    mediaAt(250, 7.5);
    assert.equal(element.currentTime, 8);

    // Landing 62.5 ms behind is eased out by playback speed instead of another seek.
    mediaAt(1_000, 8);
    mediaAt(250, 8.1875);
    assert.equal(element.currentTime, 8.1875);
    assert.equal(element.playbackRate, 1 + 62.5 / 4_000);

    // A stall far behind seeks back onto the clock, leading by the learned rebuffer time.
    nowMs += 3_000;
    element.dispatchEvent(new Event("playing"));
    assert.equal(element.currentTime, 12.3125);
    assert.equal(element.playbackRate, 1);

    // A busy engine reports less progress than real time; media slows down to follow it.
    nowMs += 1_200;
    element.currentTime = 12.5;
    await host.applyDirective(
      { type: "Sync", data: { timeline_uid, offset: { secs: 12, nanos: 0 } } },
      session,
    );
    assert.equal(element.currentTime, 12.5);
    assert.equal(element.playbackRate, 0.95);

    host.setLoop(timeline_uid, {
      start: { secs: 2, nanos: 0 },
      end: { secs: 14, nanos: 0 },
    });
    mediaAt(3_000, 2);
    assert.equal(element.currentTime, 2);

    await host.applyDirective(
      { type: "Pause", data: { timeline_uid } },
      session,
    );
    mediaAt(5_000, 2);
    assert.equal(element.currentTime, 2);
    assert.equal(element.playbackRate, 1);

    // The next start already seeks ahead by the learned rebuffer time.
    host.setLoop(timeline_uid, undefined);
    const resumed = host.applyDirective(
      { type: "Play", data: { timeline_uid, offset: { secs: 20, nanos: 0 } } },
      session,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(element.currentTime, 21.0625);
    element.finishBuffering();
    await resumed;
    host.unload();
  } finally {
    if (previous) Object.defineProperty(globalThis, "Audio", previous);
    else Reflect.deleteProperty(globalThis, "Audio");
  }
});
