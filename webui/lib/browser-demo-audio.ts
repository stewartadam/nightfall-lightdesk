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

// Drift this small is inaudible and left alone.
const CLOCK_DRIFT_TOLERANCE_MS = 40;
// Drift past this is closed with a seek; smaller drift is eased out by playback speed,
// because Safari and iOS rebuffer on every seek and would drift again while doing so.
const CLOCK_SEEK_THRESHOLD_MS = 1_000;
// Gives a corrective seek time to rebuffer before another seek is considered.
const CLOCK_RESYNC_COOLDOWN_MS = 3_000;
// Largest playback speed change used to ease out drift, well below audible pitch artefacts.
const MAX_RATE_CORRECTION = 0.05;
// Drift that playback speed aims to remove within this much playback.
const RATE_CORRECTION_HORIZON_MS = 4_000;
// `HTMLMediaElement.HAVE_FUTURE_DATA`: enough media is buffered to keep playing.
const HAVE_FUTURE_DATA = 3;

/** Engine playback position paired with the local monotonic instant it applied. */
interface EngineClockAnchor {
  positionMs: number;
  atMs: number;
}

/** Reads the browser's monotonic clock in milliseconds. */
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

/** Main-thread host for authoritative, gesture-gated browser demo audio effects. */
export class BrowserDemoAudioHost {
  readonly element: HTMLAudioElement;
  private loaded = false;
  private hasPlayed = false;
  private audioUrl: string | null = null;
  private session = 0;
  private timelineUid: string | null = null;
  private loopRangeMs: { start: number; end: number } | null = null;
  private unlockPromise: Promise<void> | null = null;
  private directiveQueue: Promise<void> = Promise.resolve();
  private clockAnchor: EngineClockAnchor | null = null;
  private lastResyncAtMs = Number.NEGATIVE_INFINITY;

  /**
   * Create an unloaded browser audio host that wraps at loop boundaries and keeps the
   * media position locked to the engine clock, read through `now`.
   */
  constructor(private readonly now: () => number = monotonicNow) {
    this.element = new Audio();
    this.element.preload = "auto";
    this.element.addEventListener("timeupdate", () => this.enforceLoopRange());
    this.element.addEventListener("timeupdate", () => this.syncToEngineClock());
    this.element.addEventListener("playing", () => this.syncToEngineClock());
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

  /**
   * Unlock media playback synchronously from the operator's Play gesture. The unlock
   * plays muted because iOS ignores writes to `volume`.
   */
  prime(timelineUid: string, audioUrl: string): Promise<void> {
    this.loadUrl(timelineUid, audioUrl);
    if (this.unlockPromise) return this.unlockPromise;
    this.element.muted = true;
    this.unlockPromise = this.element.play().then(() => {
      this.element.pause();
      this.element.currentTime = 0;
      this.element.muted = false;
    });
    return this.unlockPromise.catch((error: unknown) => {
      this.element.muted = false;
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
    this.releaseEngineClock();
    this.timelineUid = timelineUid;
    this.audioUrl = audioUrl;
    this.loopRangeMs = null;
    this.unlockPromise = null;
    this.element.src = audioUrl;
    this.element.load();
    this.loaded = true;
    this.hasPlayed = false;
    this.publishState();
    log.debug("Loaded showfile-selected browser demo audio");
  }

  /**
   * Start or resume playback for the active timeline. When `requestedAtMs` is given, the
   * engine started its clock at `positionMs` at that instant, so the media starts at
   * wherever that clock is now and is corrected again once sound actually begins.
   */
  async play(
    timelineUid: string,
    positionMs: number,
    requestedAtMs?: number,
  ): Promise<void> {
    this.assertTimeline(timelineUid);
    if (this.unlockPromise) await this.unlockPromise;
    const startAtMs = this.now();
    this.clockAnchor = { positionMs, atMs: requestedAtMs ?? startAtMs };
    this.lastResyncAtMs = Number.NEGATIVE_INFINITY;
    this.seek(timelineUid, this.engineClockPositionMs(startAtMs) ?? positionMs);
    await this.element.play();
    this.hasPlayed = true;
    this.publishState();
    this.syncToEngineClock();
  }

  /**
   * Re-anchor playing media to the engine position reported at `reportedAtMs` and correct
   * any drift from it. The engine clock can run slower than real time on
   * a busy device, so playback follows these reports rather than the local clock alone.
   */
  followEngineClock(
    timelineUid: string,
    positionMs: number,
    reportedAtMs: number,
  ): void {
    if (!this.clockAnchor || this.timelineUid !== timelineUid) return;
    this.clockAnchor = { positionMs, atMs: reportedAtMs };
    this.syncToEngineClock();
  }

  /** Pause playback without changing the current position. */
  pause(timelineUid: string): void {
    if (!this.loaded || this.timelineUid !== timelineUid) return;
    this.assertTimeline(timelineUid);
    this.releaseEngineClock();
    this.element.pause();
    this.publishState();
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
    this.releaseEngineClock();
    this.hasPlayed = false;
    this.element.pause();
    this.element.currentTime = 0;
    this.publishState();
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
    const receivedAtMs = this.now();
    const operation = this.directiveQueue.then(() =>
      this.applyDirectiveInOrder(directive, session, receivedAtMs),
    );
    this.directiveQueue = operation.catch(() => undefined);
    return operation;
  }

  /**
   * Apply one directive after all earlier media operations have settled. `receivedAtMs`
   * marks when it arrived, so queued playback still lands on the engine clock.
   */
  private async applyDirectiveInOrder(
    directive: types.TimelineAudioDirective,
    session: number,
    receivedAtMs: number,
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
          receivedAtMs,
        );
        break;
      case "Sync":
        this.followEngineClock(
          directive.data.timeline_uid,
          durationToMs(directive.data.offset),
          receivedAtMs,
        );
        break;
      case "Pause":
        this.pause(directive.data.timeline_uid);
        break;
      case "Seek":
        this.releaseEngineClock();
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
    this.releaseEngineClock();
    this.loaded = false;
    this.hasPlayed = false;
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

  /** Stop following the engine clock until the next Play directive anchors it again. */
  private releaseEngineClock(): void {
    this.clockAnchor = null;
    this.element.playbackRate = 1;
  }

  /**
   * Project the engine's playback position at `nowMs` from the last Play or Sync report.
   * Returns `null` when the engine is not playing.
   */
  private engineClockPositionMs(nowMs: number): number | null {
    const anchor = this.clockAnchor;
    if (!anchor) return null;
    return anchor.positionMs + Math.max(0, nowMs - anchor.atMs);
  }

  /**
   * Keep the media on the engine clock. Large drift, e.g. a phone still fetching audio when
   * the engine started or playback that stalled on the network, is closed with a seek.
   * Smaller drift is eased out by nudging the playback speed, so Safari and iOS never
   * rebuffer for it. Media that is still buffering is left alone, and seeks are rate
   * limited so a rebuffering seek is not chased. Past the loop end the engine sends a fresh
   * Play from the loop start, so the projection is not trusted there.
   */
  private syncToEngineClock(): void {
    if (
      !this.timelineUid ||
      this.element.paused ||
      this.element.seeking ||
      this.element.readyState < HAVE_FUTURE_DATA
    ) {
      return;
    }
    const nowMs = this.now();
    const expectedMs = this.engineClockPositionMs(nowMs);
    if (expectedMs === null) return;
    if (this.loopRangeMs && expectedMs >= this.loopRangeMs.end) return;
    const driftMs = this.element.currentTime * 1_000 - expectedMs;
    if (
      Math.abs(driftMs) >= CLOCK_SEEK_THRESHOLD_MS &&
      nowMs - this.lastResyncAtMs >= CLOCK_RESYNC_COOLDOWN_MS
    ) {
      this.lastResyncAtMs = nowMs;
      this.element.playbackRate = 1;
      log.debug(
        `Seeking browser demo audio that drifted ${Math.round(driftMs)}ms from the engine clock`,
      );
      this.seek(this.timelineUid, expectedMs);
      return;
    }
    const correction =
      Math.abs(driftMs) <= CLOCK_DRIFT_TOLERANCE_MS
        ? 0
        : Math.max(
            -MAX_RATE_CORRECTION,
            Math.min(MAX_RATE_CORRECTION, driftMs / RATE_CORRECTION_HORIZON_MS),
          );
    const rate = 1 - correction;
    if (this.element.playbackRate !== rate) this.element.playbackRate = rate;
  }

  /** Publish a stable diagnostic snapshot without exposing the media element. */
  private publishState(): void {
    browserDemoAudioState.set({
      session: this.session,
      status: !this.loaded
        ? "unloaded"
        : this.element.paused
          ? this.hasPlayed
            ? "paused"
            : "ready"
          : "playing",
      positionMs: this.element.currentTime * 1_000,
    });
  }
}

/** Singleton media host owned by the current application page. */
export const browserDemoAudioHost = new BrowserDemoAudioHost();
