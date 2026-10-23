// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { browserDemoAudioState } from "../state/appStores";
import type * as types from "../types";
import { getLogger } from "./logger";
import {
  type AudioTrack,
  DecodedBufferTrack,
  openStreamingTrack,
} from "./streaming-audio/track";
import { type LoopRangeMs, StreamingVoice } from "./streaming-audio/voice";
import { resolveTimelineAudioUrl } from "./timeline-audio";
import { durationToMs } from "./utils";

const log = getLogger(import.meta.url);

// Drift this small is inaudible and left alone; larger drift restarts playback on the clock.
const CLOCK_DRIFT_TOLERANCE_MS = 30;
// How often the diagnostic playback position is published while audio plays.
const STATE_PUBLISH_INTERVAL_MS = 250;
// Sample rate used to decode audio that cannot be streamed, before any playback context exists.
const DECODE_SAMPLE_RATE = 48_000;

/** Engine playback position paired with the local monotonic instant it applied. */
interface EngineClockAnchor {
  positionMs: number;
  atMs: number;
}

/** Browser audio services the host depends on, replaceable for tests. */
export interface BrowserDemoAudioBackend {
  /** Create the playback context; only called once a timeline needs to play. */
  createContext(): AudioContext;
  /** Open one bundled audio file for playback. */
  open(url: string): Promise<AudioTrack>;
}

/**
 * Open `url` for streaming, or decode it whole when its format or the browser does not
 * allow streaming. Decoding needs no user gesture or playback context.
 */
async function openAudioUrl(url: string): Promise<AudioTrack> {
  const streaming = await openStreamingTrack(url);
  if (streaming) return streaming;
  log.debug("Decoding browser demo audio whole; it cannot be streamed");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to fetch timeline audio (${response.status})`);
  }
  const bytes = await response.arrayBuffer();
  const buffer = await new OfflineAudioContext(
    1,
    1,
    DECODE_SAMPLE_RATE,
  ).decodeAudioData(bytes);
  return new DecodedBufferTrack(buffer);
}

/**
 * Create the playback context. On iOS the audio session is switched to playback so the
 * ring/silent switch does not mute the show, matching how media elements behave.
 */
function createPlaybackContext(): AudioContext {
  const session = (navigator as { audioSession?: { type: string } })
    .audioSession;
  if (session) session.type = "playback";
  return new AudioContext({ latencyHint: "interactive" });
}

const browserAudioBackend: BrowserDemoAudioBackend = {
  createContext: createPlaybackContext,
  open: openAudioUrl,
};

/** Reads the browser's monotonic clock in milliseconds. */
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

/**
 * Main-thread host for authoritative, gesture-gated browser demo audio effects. Audio is
 * streamed: a few seconds at a time are decoded and scheduled on the Web Audio clock, so
 * starts and seeks are exact on every browser and memory stays constant however long
 * the timeline's audio is.
 */
export class BrowserDemoAudioHost {
  private context: AudioContext | null = null;
  private loaded = false;
  private hasPlayed = false;
  private audioUrl: string | null = null;
  private session = 0;
  private timelineUid: string | null = null;
  private loopRangeMs: LoopRangeMs | null = null;
  private pendingTrack: Promise<AudioTrack> | null = null;
  private track: AudioTrack | null = null;
  private voice: StreamingVoice | null = null;
  // A voice preparing to take over from `voice` once its first audio is decoded, and the
  // position it is joining.
  private incomingVoice: StreamingVoice | null = null;
  private incomingPositionMs: ((nowMs: number) => number) | null = null;
  private pausedAtMs = 0;
  private directiveQueue: Promise<void> = Promise.resolve();
  private clockAnchor: EngineClockAnchor | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private gestureTarget: EventTarget | null = null;

  /**
   * Create an unloaded browser audio host that keeps playback locked to the engine clock,
   * read through `now`, using `backend` for decoding and output.
   */
  constructor(
    private readonly now: () => number = monotonicNow,
    private readonly backend: BrowserDemoAudioBackend = browserAudioBackend,
  ) {
    this.publishState();
  }

  /** Starts a new engine session and releases all effects owned by the old one. */
  beginSession(): number {
    this.session += 1;
    this.unload();
    this.publishState();
    return this.session;
  }

  /**
   * Unlock audio output synchronously from the operator's Play gesture and start opening
   * the timeline's audio. Browsers only let a gesture resume audio output, so this runs
   * on every Play press. Neither opening nor the resume is awaited: the engine clock
   * starts right away and the audio joins it once the first samples are decoded. Some
   * browsers keep the resume pending indefinitely when they refuse audio output, which
   * must not hold back the timeline.
   */
  prime(timelineUid: string, audioUrl: string): void {
    this.loadUrl(timelineUid, audioUrl);
    void this.playbackContext().resume();
  }

  /**
   * Resume audio output on every user gesture in `target`. Browsers only unlock audio from
   * a gesture, and Safari suspends it again after interruptions, so playback started from
   * a shortcut, board or cue still has sound. Installing twice is a no-op.
   */
  unlockOnUserGesture(target: EventTarget): void {
    if (this.gestureTarget) return;
    this.gestureTarget = target;
    /** Create or resume the playback context while the browser counts a gesture. */
    const unlock = () => {
      const context = this.playbackContext();
      if (context.state !== "running") void context.resume();
    };
    for (const type of ["pointerdown", "keydown", "touchend"]) {
      target.addEventListener(type, unlock, { capture: true, passive: true });
    }
  }

  /** Returns the token identifying the currently active engine session. */
  currentSession(): number {
    return this.session;
  }

  /** Load the bundled asset selected by the requesting timeline's showfile data. */
  load(timelineUid: string, assetId: string): void {
    this.loadUrl(timelineUid, resolveTimelineAudioUrl(assetId));
  }

  /** Start opening one already resolved bundled URL for the timeline. */
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
    this.stopVoices();
    this.releaseEngineClock();
    this.releaseTrack();
    this.timelineUid = timelineUid;
    this.audioUrl = audioUrl;
    this.loopRangeMs = null;
    this.pausedAtMs = 0;
    const pending = this.backend.open(audioUrl);
    this.pendingTrack = pending;
    pending.then(
      (track) => {
        if (this.pendingTrack === pending) this.track = track;
        else track.close();
      },
      (error: unknown) => {
        if (this.pendingTrack !== pending) return;
        log.warn("Unable to open browser demo audio", error);
      },
    );
    this.loaded = true;
    this.hasPlayed = false;
    this.publishState();
    log.debug("Loaded showfile-selected browser demo audio");
  }

  /**
   * Start or resume playback for the active timeline. When `requestedAtMs` is given, the
   * engine started its clock at `positionMs` at that instant, so audio joins wherever
   * that clock is once the first samples are decoded. Audio that is already playing on
   * that clock, e.g. across a loop restart, carries on without a restart.
   */
  async play(
    timelineUid: string,
    positionMs: number,
    requestedAtMs?: number,
  ): Promise<void> {
    this.assertTimeline(timelineUid);
    const pending = this.pendingTrack;
    if (!pending) return;
    await pending;
    if (this.pendingTrack !== pending) return;
    const context = this.playbackContext();
    if (context.state !== "running") {
      // Without a gesture yet the voice stays silent; the next gesture resumes output and
      // the following Sync puts it back on the engine clock.
      log.debug("Browser demo audio output is waiting for a user gesture");
      void context.resume();
    }
    this.clockAnchor = { positionMs, atMs: requestedAtMs ?? this.now() };
    this.hasPlayed = true;
    this.followClock();
  }

  /**
   * Re-anchor playing audio to the engine position reported at `reportedAtMs` and correct
   * any drift from it. The engine clock can run slower than real time on a busy device,
   * so playback follows these reports rather than the audio clock alone.
   */
  followEngineClock(
    timelineUid: string,
    positionMs: number,
    reportedAtMs: number,
  ): void {
    if (!this.clockAnchor || this.timelineUid !== timelineUid) return;
    this.clockAnchor = { positionMs, atMs: reportedAtMs };
    this.followClock();
  }

  /** Pause playback without changing the current position. */
  pause(timelineUid: string): void {
    if (!this.loaded || this.timelineUid !== timelineUid) return;
    this.assertTimeline(timelineUid);
    this.pausedAtMs = this.positionMs();
    this.releaseEngineClock();
    this.stopVoices();
    this.publishState();
  }

  /** Move the active timeline to a position in milliseconds, continuing if it plays. */
  seek(timelineUid: string, positionMs: number): void {
    this.assertTimeline(timelineUid);
    const targetMs = this.clampToTrack(positionMs);
    if (this.isPlaying()) this.startVoice(this.freeRunningFrom(targetMs));
    else this.pausedAtMs = targetMs;
    this.publishState();
  }

  /** Stop playback and return the active timeline to the audio beginning. */
  stop(timelineUid: string): void {
    if (!this.loaded || this.timelineUid !== timelineUid) return;
    this.assertTimeline(timelineUid);
    this.releaseEngineClock();
    this.stopVoices();
    this.hasPlayed = false;
    this.pausedAtMs = 0;
    this.publishState();
  }

  /**
   * Set or clear loop bounds for the active timeline. Audio already scheduled carries on
   * when it still fits the new bounds, and restarts at the current position otherwise.
   */
  setLoop(
    timelineUid: string,
    range: types.TimelineAudioLoopRange | undefined,
  ): void {
    this.assertTimeline(timelineUid);
    this.loopRangeMs = range
      ? { start: durationToMs(range.start), end: durationToMs(range.end) }
      : null;
    this.incomingVoice?.setLoop(this.loopRangeMs);
    if (this.voice && !this.voice.setLoop(this.loopRangeMs)) {
      this.startVoice(
        this.clockAnchor
          ? this.engineClock()
          : this.freeRunningFrom(this.wrapToLoop(this.positionMs())),
      );
    }
  }

  /**
   * Apply one timeline-authored effect when it belongs to the current session. `sentAtMs`
   * is when the engine sent it on this clock, so time spent reaching a busy main thread
   * does not shift the engine clock carried by Play and Sync.
   */
  async applyDirective(
    directive: types.TimelineAudioDirective,
    session: number,
    sentAtMs?: number,
  ): Promise<void> {
    const nowMs = this.now();
    const issuedAtMs = Math.min(nowMs, sentAtMs ?? nowMs);
    const operation = this.directiveQueue.then(() =>
      this.applyDirectiveInOrder(directive, session, issuedAtMs),
    );
    this.directiveQueue = operation.catch(() => undefined);
    return operation;
  }

  /**
   * Apply one directive after all earlier operations have settled. `issuedAtMs` marks
   * when the engine sent it, so playback queued behind opening still lands on the engine clock.
   */
  private async applyDirectiveInOrder(
    directive: types.TimelineAudioDirective,
    session: number,
    issuedAtMs: number,
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
          issuedAtMs,
        );
        break;
      case "Sync":
        this.followEngineClock(
          directive.data.timeline_uid,
          durationToMs(directive.data.offset),
          issuedAtMs,
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

  /** Release the opened audio and stop any playback. The output context is kept unlocked. */
  unload(): void {
    this.stopVoices();
    this.releaseEngineClock();
    this.releaseTrack();
    this.loaded = false;
    this.hasPlayed = false;
    this.audioUrl = null;
    this.timelineUid = null;
    this.loopRangeMs = null;
    this.pausedAtMs = 0;
    this.publishState();
  }

  /** Reject effects that do not belong to the currently loaded timeline. */
  private assertTimeline(timelineUid: string): void {
    if (!this.loaded || this.timelineUid !== timelineUid) {
      throw new Error(`Browser demo audio is not loaded for ${timelineUid}`);
    }
  }

  /** Return the playback context, creating it on first use. */
  private playbackContext(): AudioContext {
    this.context ??= this.backend.createContext();
    return this.context;
  }

  /** Stop following the engine clock until the next Play directive anchors it again. */
  private releaseEngineClock(): void {
    this.clockAnchor = null;
  }

  /** Close the opened track, or the one still opening once it arrives. */
  private releaseTrack(): void {
    this.track?.close();
    this.track = null;
    this.pendingTrack = null;
  }

  /** Whether audio is playing or about to. */
  private isPlaying(): boolean {
    return this.voice !== null || this.incomingVoice !== null;
  }

  /**
   * Project the engine's playback position at `nowMs` from the last Play or Sync report,
   * wrapped into the loop range the way looping audio wraps. Returns `null` when the
   * engine is not playing.
   */
  private engineClockPositionMs(nowMs: number): number | null {
    const anchor = this.clockAnchor;
    if (!anchor) return null;
    return this.wrapToLoop(
      anchor.positionMs + Math.max(0, nowMs - anchor.atMs),
    );
  }

  /** Expected position that follows the engine clock as Sync reports update it. */
  private engineClock(): (nowMs: number) => number {
    let lastMs = this.positionMs();
    return (nowMs) => {
      lastMs = this.engineClockPositionMs(nowMs) ?? lastMs;
      return lastMs;
    };
  }

  /** Expected position that runs on from `positionMs` in real time, starting now. */
  private freeRunningFrom(positionMs: number): (nowMs: number) => number {
    const atMs = this.now();
    return (nowMs) => this.wrapToLoop(positionMs + Math.max(0, nowMs - atMs));
  }

  /**
   * Keep audio on the engine clock: start it when nothing plays, and restart it at the
   * engine position when it has drifted audibly away. Audio still joining the clock is
   * left to finish joining.
   */
  private followClock(): void {
    const projected = this.engineClockPositionMs(this.now());
    if (projected === null || this.incomingVoice || !this.track) return;
    const expectedMs = this.clampToTrack(projected);
    if (this.voice) {
      const driftMs = this.voice.heardPositionMs() - expectedMs;
      if (Math.abs(driftMs) <= CLOCK_DRIFT_TOLERANCE_MS) return;
      log.debug(
        `Restarting browser demo audio that drifted ${Math.round(driftMs)}ms from the engine clock`,
      );
    } else if (expectedMs >= this.trackDurationMs()) {
      return;
    }
    this.startVoice(this.engineClock());
  }

  /**
   * Start a voice that joins `expectedPositionMs` once its first audio is decoded. The
   * current voice keeps playing until then and hands over with a short crossfade, so a
   * restart never leaves a gap.
   */
  private startVoice(expectedPositionMs: (nowMs: number) => number): void {
    const track = this.track;
    if (!track) return;
    this.incomingVoice?.stop();
    const voice = new StreamingVoice({
      context: this.playbackContext(),
      track,
      now: this.now,
      expectedPositionMs,
      loop: this.loopRangeMs,
      /** Hand over from the current voice, or stop it when there is nothing to play. */
      onStart: (startTime) => {
        if (this.incomingVoice !== voice) return;
        this.incomingVoice = null;
        this.incomingPositionMs = null;
        this.voice?.stop(startTime ?? undefined);
        this.voice = startTime === null ? null : voice;
        if (!this.isPlaying()) this.stopPublishing();
        this.publishState();
      },
    });
    this.incomingVoice = voice;
    this.incomingPositionMs = expectedPositionMs;
    this.publishTimer ??= setInterval(
      () => this.publishState(),
      STATE_PUBLISH_INTERVAL_MS,
    );
    voice.start();
    this.publishState();
  }

  /** Stop the current and incoming voices. */
  private stopVoices(): void {
    this.incomingVoice?.stop();
    this.incomingVoice = null;
    this.incomingPositionMs = null;
    this.voice?.stop();
    this.voice = null;
    this.stopPublishing();
  }

  /** Stop publishing the playback position periodically. */
  private stopPublishing(): void {
    if (this.publishTimer !== null) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }
  }

  /** Wrap a position past the loop end back into the loop range. */
  private wrapToLoop(positionMs: number): number {
    const loop = this.loopRangeMs;
    if (!loop || positionMs < loop.end || loop.end <= loop.start) {
      return positionMs;
    }
    return loop.start + ((positionMs - loop.start) % (loop.end - loop.start));
  }

  /** Length of the opened audio, or infinity while it is unknown. */
  private trackDurationMs(): number {
    return this.track?.durationMs() ?? Number.POSITIVE_INFINITY;
  }

  /** Clamp a position to the opened audio's length, when it is known. */
  private clampToTrack(positionMs: number): number {
    return Math.min(this.trackDurationMs(), Math.max(0, positionMs));
  }

  /**
   * The position being heard now. While a voice is still joining, e.g. after a seek, the
   * position it is joining stands in for it; when nothing plays, it is where playback
   * paused.
   */
  private positionMs(): number {
    if (this.incomingPositionMs) {
      return this.clampToTrack(this.incomingPositionMs(this.now()));
    }
    if (this.voice) return this.clampToTrack(this.voice.heardPositionMs());
    return this.pausedAtMs;
  }

  /** Publish a stable diagnostic snapshot of the playback state. */
  private publishState(): void {
    browserDemoAudioState.set({
      session: this.session,
      status: !this.loaded
        ? "unloaded"
        : this.isPlaying()
          ? "playing"
          : this.hasPlayed
            ? "paused"
            : "ready",
      positionMs: this.positionMs(),
    });
  }
}

/** Singleton audio host owned by the current application page. */
export const browserDemoAudioHost = new BrowserDemoAudioHost();
