// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { browserDemoAudioState } from "../state/appStores";
import type * as types from "../types";
import { getLogger } from "./logger";
import { resolveTimelineAudioUrl } from "./timeline-audio";
import { durationToMs } from "./utils";

const log = getLogger(import.meta.url);

/** Main-thread host for authoritative, gesture-gated browser demo audio effects. */
export class BrowserDemoAudioHost {
  readonly element: HTMLAudioElement;
  private loaded = false;
  private audioUrl: string | null = null;
  private session = 0;
  private timelineUid: string | null = null;
  private loopRangeMs: { start: number; end: number } | null = null;
  private unlockPromise: Promise<void> | null = null;
  private directiveQueue: Promise<void> = Promise.resolve();

  /** Create an unloaded browser audio host and install loop-boundary handling. */
  constructor() {
    this.element = new Audio();
    this.element.preload = "auto";
    this.element.addEventListener("timeupdate", () => this.enforceLoopRange());
    this.element.addEventListener("timeupdate", () => this.publishState());
    this.element.addEventListener("play", () => this.publishState());
    this.element.addEventListener("pause", () => this.publishState());
  }

  /** Starts a new engine session and releases all effects owned by the old one. */
  beginSession(): number {
    this.session += 1;
    this.unload();
    this.publishState();
    return this.session;
  }

  /** Unlock media playback synchronously from the operator's Play gesture. */
  prime(timelineUid: string, audioUrl: string): Promise<void> {
    this.loadUrl(timelineUid, audioUrl);
    if (this.unlockPromise) return this.unlockPromise;
    const previousVolume = this.element.volume;
    this.element.volume = 0;
    this.unlockPromise = this.element.play().then(() => {
      this.element.pause();
      this.element.currentTime = 0;
      this.element.volume = previousVolume;
    });
    return this.unlockPromise.catch((error: unknown) => {
      this.element.volume = previousVolume;
      this.unlockPromise = null;
      throw error;
    });
  }

  /** Returns the token identifying the currently active engine session. */
  currentSession(): number {
    return this.session;
  }

  /** Load the bundled asset selected by the requesting timeline's showfile data. */
  load(timelineUid: string, assetId: string): void {
    this.loadUrl(timelineUid, resolveTimelineAudioUrl(assetId));
  }

  /** Attach one already resolved bundled URL to the browser media element. */
  private loadUrl(timelineUid: string, audioUrl: string): void {
    if (!audioUrl.trim()) {
      throw new Error(
        `Browser demo audio is not configured for ${timelineUid}`,
      );
    }
    if (
      this.loaded &&
      this.timelineUid === timelineUid &&
      this.audioUrl === audioUrl
    ) {
      return;
    }
    if (this.loaded) this.element.pause();
    this.timelineUid = timelineUid;
    this.audioUrl = audioUrl;
    this.loopRangeMs = null;
    this.unlockPromise = null;
    this.element.src = audioUrl;
    this.element.load();
    this.loaded = true;
    this.publishState();
    log.debug("Loaded showfile-selected browser demo audio");
  }

  /** Start or resume playback for the active timeline. */
  async play(timelineUid: string, positionMs: number): Promise<void> {
    this.assertTimeline(timelineUid);
    if (this.unlockPromise) await this.unlockPromise;
    this.seek(timelineUid, positionMs);
    await this.element.play();
  }

  /** Pause playback without changing the current position. */
  pause(timelineUid: string): void {
    if (!this.loaded || this.timelineUid !== timelineUid) return;
    this.assertTimeline(timelineUid);
    this.element.pause();
  }

  /** Seek the active timeline to a bounded position expressed in milliseconds. */
  seek(timelineUid: string, positionMs: number): void {
    this.assertTimeline(timelineUid);
    const requestedSeconds = Math.max(0, positionMs / 1_000);
    this.element.currentTime = Number.isFinite(this.element.duration)
      ? Math.min(this.element.duration, requestedSeconds)
      : requestedSeconds;
  }

  /** Stop playback and return the active timeline to the audio beginning. */
  stop(timelineUid: string): void {
    if (!this.loaded || this.timelineUid !== timelineUid) return;
    this.assertTimeline(timelineUid);
    this.element.pause();
    this.element.currentTime = 0;
  }

  /** Set or clear media-loop bounds for the active timeline. */
  setLoop(
    timelineUid: string,
    range: types.TimelineAudioLoopRange | undefined,
  ): void {
    this.assertTimeline(timelineUid);
    this.loopRangeMs = range
      ? { start: durationToMs(range.start), end: durationToMs(range.end) }
      : null;
  }

  /** Apply one timeline-authored effect when it belongs to the current session. */
  async applyDirective(
    directive: types.TimelineAudioDirective,
    session: number,
  ): Promise<void> {
    const operation = this.directiveQueue.then(() =>
      this.applyDirectiveInOrder(directive, session),
    );
    this.directiveQueue = operation.catch(() => undefined);
    return operation;
  }

  /** Apply one directive after all earlier media operations have settled. */
  private async applyDirectiveInOrder(
    directive: types.TimelineAudioDirective,
    session: number,
  ): Promise<void> {
    if (session !== this.session) return;
    switch (directive.type) {
      case "Load":
        this.load(directive.data.timeline_uid, directive.data.asset_id);
        break;
      case "Play":
        await this.play(
          directive.data.timeline_uid,
          durationToMs(directive.data.offset),
        );
        break;
      case "Pause":
        this.pause(directive.data.timeline_uid);
        break;
      case "Seek":
        this.seek(
          directive.data.timeline_uid,
          durationToMs(directive.data.offset),
        );
        break;
      case "Stop":
        this.stop(directive.data.timeline_uid);
        break;
      case "SetLoop":
        this.setLoop(directive.data.timeline_uid, directive.data.range);
        break;
      case "Unload":
        if (this.timelineUid === directive.data.timeline_uid) this.unload();
        break;
    }
  }

  /** Detach the bundled audio and release browser media state. */
  unload(): void {
    if (this.loaded) {
      this.element.pause();
      this.element.removeAttribute("src");
      this.element.load();
    }
    this.loaded = false;
    this.audioUrl = null;
    this.timelineUid = null;
    this.loopRangeMs = null;
    this.unlockPromise = null;
    this.publishState();
  }

  /** Reject effects that do not belong to the currently loaded timeline. */
  private assertTimeline(timelineUid: string): void {
    if (!this.loaded || this.timelineUid !== timelineUid) {
      throw new Error(`Browser demo audio is not loaded for ${timelineUid}`);
    }
  }

  /** Wrap media playback at the configured loop boundary. */
  private enforceLoopRange(): void {
    if (!this.loopRangeMs || this.element.paused) return;
    if (this.element.currentTime * 1_000 >= this.loopRangeMs.end) {
      this.element.currentTime = this.loopRangeMs.start / 1_000;
    }
  }

  /** Publish a stable diagnostic snapshot without exposing the media element. */
  private publishState(): void {
    browserDemoAudioState.set({
      session: this.session,
      status: !this.loaded
        ? "unloaded"
        : this.element.paused
          ? this.element.currentTime > 0
            ? "paused"
            : "ready"
          : "playing",
      positionMs: this.element.currentTime * 1_000,
    });
  }
}

/** Singleton media host owned by the current application page. */
export const browserDemoAudioHost = new BrowserDemoAudioHost();
