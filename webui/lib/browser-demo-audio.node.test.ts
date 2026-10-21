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
 * Audio that starts late or stalls is pulled back onto the engine clock, follows the
 * engine's Sync reports when the engine runs slower than real time, waits for the engine
 * to restart it at the loop end, and is left alone once playback is paused.
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
    const unlocked = host.prime(timeline_uid, "https://example.test/demo.mp3");
    element.finishBuffering();
    await unlocked;
    assert.equal(element.muted, false);

    const playing = host.applyDirective(
      { type: "Play", data: { timeline_uid, offset: { secs: 4, nanos: 0 } } },
      session,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    nowMs += 2_500;
    element.finishBuffering();
    await playing;
    assert.equal(element.currentTime, 6.5);

    nowMs += 400;
    element.currentTime = 6.85;
    element.dispatchEvent(new Event("timeupdate"));
    assert.equal(element.currentTime, 6.85);

    nowMs += 3_000;
    element.dispatchEvent(new Event("playing"));
    assert.equal(element.currentTime, 9.9);

    // A busy engine reports less progress than real time; media follows the engine.
    nowMs += 1_200;
    element.currentTime = 11.1;
    await host.applyDirective(
      {
        type: "Sync",
        data: { timeline_uid, offset: { secs: 10, nanos: 500_000_000 } },
      },
      session,
    );
    assert.equal(element.currentTime, 10.5);

    host.setLoop(timeline_uid, {
      start: { secs: 2, nanos: 0 },
      end: { secs: 12, nanos: 0 },
    });
    nowMs += 3_000;
    element.currentTime = 2;
    element.dispatchEvent(new Event("timeupdate"));
    assert.equal(element.currentTime, 2);

    await host.applyDirective(
      { type: "Pause", data: { timeline_uid } },
      session,
    );
    nowMs += 5_000;
    element.dispatchEvent(new Event("timeupdate"));
    assert.equal(element.currentTime, 2);
    host.unload();
  } finally {
    if (previous) Object.defineProperty(globalThis, "Audio", previous);
    else Reflect.deleteProperty(globalThis, "Audio");
  }
});
