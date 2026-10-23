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

// Drift this small is inaudible and left alone; larger drift restarts playback on the clock.
const CLOCK_DRIFT_TOLERANCE_MS = 30;
// Fade applied when a voice starts or stops, short enough to be inaudible but long enough
// to avoid clicks when playback restarts mid-waveform.
const VOICE_FADE_SECONDS = 0.01;
// How often the diagnostic playback position is published while audio plays.
const STATE_PUBLISH_INTERVAL_MS = 250;
// Sample rate used to decode audio before any playback context exists.
const DECODE_SAMPLE_RATE = 48_000;

/** Engine playback position paired with the local monotonic instant it applied. */
interface EngineClockAnchor {
  positionMs: number;
  atMs: number;
}

/** One scheduled run of the decoded buffer and the audible position it started from. */
interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  originMs: number;
  startedAt: number;
}

/** Browser audio services the host depends on, replaceable for tests. */
export interface BrowserDemoAudioBackend {
  /** Create the playback context; only called once a timeline needs to play. */
  createContext(): AudioContext;
  /** Fetch and decode one bundled audio file into memory. */
  decode(url: string): Promise<AudioBuffer>;
}

/** Fetch an audio file and decode it without needing a user gesture or playback context. */
async function decodeAudioUrl(url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to fetch timeline audio (${response.status})`);
  }
  const bytes = await response.arrayBuffer();
  return new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE).decodeAudioData(
    bytes,
  );
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
  decode: decodeAudioUrl,
};

/** Reads the browser's monotonic clock in milliseconds. */
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

/**
 * Main-thread host for authoritative, gesture-gated browser demo audio effects. Audio is
 * decoded into memory and scheduled on the Web Audio clock, so starts and seeks are exact
 * and immediate on every browser instead of depending on media element buffering and the
 * position each browser chooses to report.
 */
export class BrowserDemoAudioHost {
  private context: AudioContext | null = null;
  private loaded = false;
  private hasPlayed = false;
  private audioUrl: string | null = null;
  private session = 0;
  private timelineUid: string | null = null;
  private loopRangeMs: { start: number; end: number } | null = null;
  private pendingBuffer: Promise<AudioBuffer> | null = null;
  private buffer: AudioBuffer | null = null;
  private voice: Voice | null = null;
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
   * Unlock audio output synchronously from the operator's Play gesture and start decoding
   * the timeline's audio. Browsers only let a gesture resume audio output, so this runs on
   * every Play press. Neither decoding nor the resume is awaited: the engine clock starts
   * right away and the audio joins it once decoded. Some browsers keep the resume pending
   * indefinitely when they refuse audio output, which must not hold back the timeline.
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

  /** Start fetching and decoding one already resolved bundled URL for the timeline. */
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
    this.stopVoice();
    this.releaseEngineClock();
    this.timelineUid = timelineUid;
    this.audioUrl = audioUrl;
    this.loopRangeMs = null;
    this.buffer = null;
    this.pausedAtMs = 0;
    const pending = this.backend.decode(audioUrl);
    this.pendingBuffer = pending;
    pending.then(
      (buffer) => {
        if (this.pendingBuffer === pending) this.buffer = buffer;
      },
      (error: unknown) => {
        if (this.pendingBuffer !== pending) return;
        log.warn("Unable to decode browser demo audio", error);
      },
    );
    this.loaded = true;
    this.hasPlayed = false;
    this.publishState();
    log.debug("Loaded showfile-selected browser demo audio");
  }

  /**
   * Start or resume playback for the active timeline. When `requestedAtMs` is given, the
   * engine started its clock at `positionMs` at that instant, so audio starts at wherever
   * that clock is once decoding finishes. Audio that is already playing on that clock,
   * e.g. across a loop restart, carries on without a restart.
   */
  async play(
    timelineUid: string,
    positionMs: number,
    requestedAtMs?: number,
  ): Promise<void> {
    this.assertTimeline(timelineUid);
    const pending = this.pendingBuffer;
    if (!pending) return;
    const buffer = await pending;
    if (this.pendingBuffer !== pending) return;
    const context = this.playbackContext();
    if (context.state !== "running") {
      // Without a gesture yet the voice stays silent; the next gesture resumes output and
      // the following Sync puts it back on the engine clock.
      log.debug("Browser demo audio output is waiting for a user gesture");
      void context.resume();
    }
    this.clockAnchor = { positionMs, atMs: requestedAtMs ?? this.now() };
    this.hasPlayed = true;
    this.followClock(buffer);
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
    if (this.buffer) this.followClock(this.buffer);
  }

  /** Pause playback without changing the current position. */
  pause(timelineUid: string): void {
    if (!this.loaded || this.timelineUid !== timelineUid) return;
    this.assertTimeline(timelineUid);
    this.releaseEngineClock();
    this.pausedAtMs = this.positionMs();
    this.stopVoice();
    this.publishState();
  }

  /** Move the active timeline to a position in milliseconds, continuing if it plays. */
  seek(timelineUid: string, positionMs: number): void {
    this.assertTimeline(timelineUid);
    const targetMs = this.clampToBuffer(positionMs);
    if (this.voice && this.buffer) this.startVoice(this.buffer, targetMs);
    else this.pausedAtMs = targetMs;
    this.publishState();
  }

  /** Stop playback and return the active timeline to the audio beginning. */
  stop(timelineUid: string): void {
    if (!this.loaded || this.timelineUid !== timelineUid) return;
    this.assertTimeline(timelineUid);
    this.releaseEngineClock();
    this.stopVoice();
    this.hasPlayed = false;
    this.pausedAtMs = 0;
    this.publishState();
  }

  /** Set or clear loop bounds for the active timeline, applied to audio already playing. */
  setLoop(
    timelineUid: string,
    range: types.TimelineAudioLoopRange | undefined,
  ): void {
    this.assertTimeline(timelineUid);
    this.loopRangeMs = range
      ? { start: durationToMs(range.start), end: durationToMs(range.end) }
      : null;
    if (this.voice) this.applyLoop(this.voice.source);
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
   * when the engine sent it, so playback queued behind decoding still lands on the engine clock.
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

  /** Release the decoded audio and stop any playback. The output context is kept unlocked. */
  unload(): void {
    this.stopVoice();
    this.releaseEngineClock();
    this.loaded = false;
    this.hasPlayed = false;
    this.audioUrl = null;
    this.timelineUid = null;
    this.loopRangeMs = null;
    this.pendingBuffer = null;
    this.buffer = null;
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

  /**
   * Keep audio on the engine clock: start it when nothing plays, and restart it at the
   * engine position when it has drifted audibly away.
   */
  private followClock(buffer: AudioBuffer): void {
    const expectedMs = this.engineClockPositionMs(this.now());
    if (expectedMs === null) return;
    if (this.voice) {
      const driftMs = this.positionMs() - expectedMs;
      if (Math.abs(driftMs) <= CLOCK_DRIFT_TOLERANCE_MS) return;
      log.debug(
        `Restarting browser demo audio that drifted ${Math.round(driftMs)}ms from the engine clock`,
      );
    }
    this.startVoice(buffer, this.clampToBuffer(expectedMs));
  }

  /**
   * Play `buffer` so that `positionMs` is what is heard right now, replacing any current
   * voice with a short crossfade. Output latency is added to the start offset so the
   * sound leaving the speakers, not the sound being scheduled, matches the position.
   */
  private startVoice(buffer: AudioBuffer, positionMs: number): void {
    const context = this.playbackContext();
    this.stopVoice();
    const latencyMs = outputLatencySeconds(context) * 1_000;
    const source = context.createBufferSource();
    source.buffer = buffer;
    this.applyLoop(source);
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    const startedAt = context.currentTime;
    gain.gain.setValueAtTime(0, startedAt);
    gain.gain.linearRampToValueAtTime(1, startedAt + VOICE_FADE_SECONDS);
    source.start(startedAt, (positionMs + latencyMs) / 1_000);
    this.voice = { source, gain, originMs: positionMs, startedAt };
    this.publishTimer ??= setInterval(
      () => this.publishState(),
      STATE_PUBLISH_INTERVAL_MS,
    );
    this.publishState();
  }

  /** Fade out and release the current voice, if any. */
  private stopVoice(): void {
    const voice = this.voice;
    if (!voice) return;
    this.voice = null;
    const context = this.playbackContext();
    const at = context.currentTime;
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, at);
    voice.gain.gain.linearRampToValueAtTime(0, at + VOICE_FADE_SECONDS);
    voice.source.stop(at + VOICE_FADE_SECONDS);
    if (this.publishTimer !== null) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }
  }

  /** Mirror the timeline loop range onto a buffer source so it wraps without a gap. */
  private applyLoop(source: AudioBufferSourceNode): void {
    const loop = this.loopRangeMs;
    source.loop = loop !== null;
    if (loop) {
      source.loopStart = loop.start / 1_000;
      source.loopEnd = loop.end / 1_000;
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

  /** Clamp a position to the decoded audio's length, when it is known. */
  private clampToBuffer(positionMs: number): number {
    const durationMs = this.buffer
      ? this.buffer.duration * 1_000
      : Number.POSITIVE_INFINITY;
    return Math.min(durationMs, Math.max(0, positionMs));
  }

  /** The position being heard now, or where playback paused. */
  private positionMs(): number {
    const voice = this.voice;
    if (!voice) return this.pausedAtMs;
    const elapsedMs =
      (this.playbackContext().currentTime - voice.startedAt) * 1_000;
    return this.clampToBuffer(this.wrapToLoop(voice.originMs + elapsedMs));
  }

  /** Publish a stable diagnostic snapshot of the playback state. */
  private publishState(): void {
    browserDemoAudioState.set({
      session: this.session,
      status: !this.loaded
        ? "unloaded"
        : this.voice
          ? "playing"
          : this.hasPlayed
            ? "paused"
            : "ready",
      positionMs: this.positionMs(),
    });
  }
}

/**
 * Time between scheduling a sample and hearing it. Safari reports no `outputLatency`, so
 * the base latency of the processing graph is the best available estimate there.
 */
function outputLatencySeconds(context: AudioContext): number {
  return context.outputLatency || context.baseLatency || 0;
}

/** Singleton audio host owned by the current application page. */
export const browserDemoAudioHost = new BrowserDemoAudioHost();
