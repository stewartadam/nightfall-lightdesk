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
