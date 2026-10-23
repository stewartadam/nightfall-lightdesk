// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getLogger } from "../logger";
import { StreamResampler } from "./resampler";
import type { AudioTrack, PcmReader } from "./track";

const log = getLogger(import.meta.url);

// Audio scheduled on the audio clock ahead of what is playing. Enough to ride out a slow
// network request, small enough that memory stays at a few megabytes.
const SCHEDULE_AHEAD_SECONDS = 3;
// How often the scheduler tops up audio ahead of the playhead.
const PUMP_INTERVAL_MS = 250;
// Time allowed between scheduling the first block and the audio clock reaching it.
const START_MARGIN_SECONDS = 0.03;
// First guess of how long fetching and decoding the first block takes.
const INITIAL_STARTUP_LEAD_MS = 250;
// Longest startup lead tried when the first block keeps arriving too late. A voice that
// is ready early waits up to this long, and the voice it replaces must still have audio
// scheduled until then, so it stays below SCHEDULE_AHEAD_SECONDS.
const MAX_STARTUP_LEAD_MS = 2_500;
// Startup attempts before giving up until the next restart.
const MAX_STARTUP_ATTEMPTS = 5;
// Fade applied when a voice starts or stops, short enough to be inaudible but long enough
// to avoid clicks when playback restarts mid-waveform.
const VOICE_FADE_SECONDS = 0.01;

/** Loop bounds of the timeline in milliseconds. */
export interface LoopRangeMs {
  start: number;
  end: number;
}

/** A run of samples at the playback rate and the track position of its first sample. */
interface Block {
  channels: Float32Array[];
  positionMs: number;
}

/** Where one scheduled block sits on the audio clock and in the track. */
interface Segment {
  start: number;
  end: number;
  positionMs: number;
}

/** What a voice needs from its host. */
export interface StreamingVoiceOptions {
  context: AudioContext;
  track: AudioTrack;
  /** The host's monotonic clock in milliseconds. */
  now: () => number;
  /** Track position that should be heard at host time `nowMs`, already wrapped to the loop. */
  expectedPositionMs: (nowMs: number) => number;
  loop: LoopRangeMs | null;
  /**
   * Called once, when the first sample has been scheduled to play at `startTime`, or with
   * `null` when there is nothing to play because the position is past the end or the
   * track failed to decode.
   */
  onStart: (startTime: number | null) => void;
}

/**
 * One continuous run of a track through Web Audio. A reader decodes the track from the
 * start position, the samples are resampled to the playback rate as one stream, and
 * consecutive blocks are scheduled back to back on the audio clock a few seconds ahead
 * of what is heard. Loops are played by reopening the reader at the loop start when the
 * loop end is reached, so memory stays constant however long the track is.
 */
export class StreamingVoice {
  private readonly context: AudioContext;
  private readonly track: AudioTrack;
  private readonly gain: GainNode;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private segments: Segment[] = [];
  private reader: PcmReader | null = null;
  private resampler: StreamResampler;
  private openedAtMs = 0;
  private sourceFramesRead = 0;
  private outputFrames = 0;
  private nextTime: number | null = null;
  private loop: LoopRangeMs | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private ended = false;
  private stopped = false;

  /** Prepare a voice; nothing is fetched until `start`. */
  constructor(private readonly options: StreamingVoiceOptions) {
    this.context = options.context;
    this.track = options.track;
    this.loop = options.loop;
    this.resampler = this.createResampler();
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
  }

  /** Whether the first sample has been scheduled. */
  get started(): boolean {
    return this.nextTime !== null;
  }

  /** Begin fetching, then join the expected position once the first block is decoded. */
  start(): void {
    void this.begin(INITIAL_STARTUP_LEAD_MS, 1).catch((error: unknown) => {
      if (this.stopped) return;
      log.warn("Unable to stream browser demo audio", error);
      this.giveUp();
    });
  }

  /**
   * Track position heard right now. Sound leaves the speakers `outputLatency` after it is
   * scheduled, so this is the position scheduled that long ago. Before the first block it
   * runs backwards from the start, and after the last block it holds where audio ran out.
   */
  heardPositionMs(): number {
    const time = this.context.currentTime - outputLatencySeconds(this.context);
    const segments = this.segments;
    if (segments.length === 0) return 0;
    const first = segments[0];
    if (time < first.start) {
      return Math.max(0, first.positionMs - (first.start - time) * 1_000);
    }
    while (segments.length > 1 && segments[1].start <= time) segments.shift();
    const current = segments[0];
    return (
      current.positionMs + (Math.min(time, current.end) - current.start) * 1_000
    );
  }

  /**
   * Apply new loop bounds. Returns `false` when audio already scheduled no longer matches
   * them, e.g. it plays past the new loop end or wraps at the old one, in which case the
   * caller restarts playback.
   */
  setLoop(loop: LoopRangeMs | null): boolean {
    const previous = this.loop;
    this.loop = loop;
    if (previous?.start === loop?.start && previous?.end === loop?.end) {
      return true;
    }
    if (!this.started) return true;
    const heard = this.heardPositionMs();
    // A wrap at the old loop end is already scheduled, or the reader already reopened
    // at the old loop start for the next block.
    const positions = [
      ...this.segments.map((segment) => segment.positionMs),
      this.producedPositionMs(),
    ];
    for (let index = 1; index < positions.length; index += 1) {
      const before = this.segments[index - 1];
      const expected = before.positionMs + (before.end - before.start) * 1_000;
      if (Math.abs(positions[index] - expected) > 1) return false;
    }
    return !loop || (heard < loop.end && this.producedPositionMs() <= loop.end);
  }

  /**
   * Fade out at audio clock time `at`, or now, and release the reader and every scheduled
   * block. Audio scheduled before `at` still plays, so a replacement can take over there.
   */
  stop(at?: number): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer();
    this.reader?.close();
    this.reader = null;
    const fadeAt = Math.max(at ?? 0, this.context.currentTime);
    const gain = this.gain.gain;
    gain.cancelScheduledValues(fadeAt);
    gain.setValueAtTime(gain.value, fadeAt);
    gain.linearRampToValueAtTime(0, fadeAt + VOICE_FADE_SECONDS);
    for (const source of this.sources) source.stop(fadeAt + VOICE_FADE_SECONDS);
    // Leave the graph once the fade has played out.
    const silentInMs =
      (fadeAt + VOICE_FADE_SECONDS - this.context.currentTime) * 1_000;
    setTimeout(() => this.gain.disconnect(), silentInMs + 100);
  }

  /**
   * Open the track a little ahead of the expected position, then schedule the first block
   * so its sound lines up with the expected position. When decoding took longer than
   * `leadMs` by more than a block, start over with a longer lead, up to
   * `MAX_STARTUP_ATTEMPTS` times in all.
   */
  private async begin(leadMs: number, attempt: number): Promise<void> {
    const requestedAtMs = this.options.now();
    const plannedMs = this.clampToTrack(
      this.options.expectedPositionMs(requestedAtMs + leadMs),
    );
    this.openAt(plannedMs);
    const block = await this.nextBlock();
    if (this.stopped) return;
    if (!block) {
      this.giveUp();
      return;
    }
    const rate = this.context.sampleRate;
    const latency = outputLatencySeconds(this.context);
    let startTime = this.earliestStartTime();
    const heardAtStartMs = this.options.expectedPositionMs(
      this.options.now() +
        (startTime + latency - this.context.currentTime) * 1_000,
    );
    const lateMs = heardAtStartMs - block.positionMs;
    if (lateMs < 0) {
      // Ready early: wait for the expected position to reach the first sample.
      startTime = Math.round((startTime - lateMs / 1_000) * rate) / rate;
    }
    const dropFrames = Math.max(0, Math.round((lateMs / 1_000) * rate));
    const length = block.channels[0].length;
    if (dropFrames >= length) {
      const tookMs = this.options.now() - requestedAtMs;
      if (attempt >= MAX_STARTUP_ATTEMPTS) {
        log.warn(
          `Browser demo audio took ${Math.round(tookMs)}ms to decode; giving up for now`,
        );
        this.giveUp();
        return;
      }
      const nextLeadMs = Math.min(
        MAX_STARTUP_LEAD_MS,
        Math.max(leadMs * 2, tookMs * 1.5),
      );
      log.debug(
        `Browser demo audio took ${Math.round(tookMs)}ms to start; retrying with a ${Math.round(nextLeadMs)}ms lead`,
      );
      return this.begin(nextLeadMs, attempt + 1);
    }
    const gain = this.gain.gain;
    gain.setValueAtTime(0, startTime);
    gain.linearRampToValueAtTime(1, startTime + VOICE_FADE_SECONDS);
    this.nextTime = startTime;
    this.schedule({
      channels: block.channels.map((channel) => channel.subarray(dropFrames)),
      positionMs: block.positionMs + (dropFrames / rate) * 1_000,
    });
    this.options.onStart(startTime);
    this.timer = setInterval(() => void this.pump(), PUMP_INTERVAL_MS);
    await this.pump();
  }

  /** Schedule blocks until the audio clock is covered `SCHEDULE_AHEAD_SECONDS` ahead. */
  private async pump(): Promise<void> {
    if (this.pumping || this.stopped || this.ended || this.nextTime === null) {
      return;
    }
    this.pumping = true;
    try {
      while (
        !this.stopped &&
        this.nextTime - this.context.currentTime < SCHEDULE_AHEAD_SECONDS
      ) {
        const block = await this.nextBlock();
        if (this.stopped) break;
        if (!block) {
          this.ended = true;
          this.clearTimer();
          break;
        }
        this.schedule(block);
      }
    } catch (error) {
      if (!this.stopped) {
        log.warn("Browser demo audio stream failed", error);
        this.ended = true;
        this.clearTimer();
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Play one block right after the previous one. When decoding fell behind the audio
   * clock, the block starts as soon as possible instead, and the gap shows up as heard
   * position falling behind.
   */
  private schedule(block: Block): void {
    const length = block.channels[0]?.length ?? 0;
    if (length === 0 || this.nextTime === null) return;
    const rate = this.context.sampleRate;
    const start = Math.max(this.nextTime, this.earliestStartTime());
    const buffer = this.context.createBuffer(
      block.channels.length,
      length,
      rate,
    );
    block.channels.forEach((channel, index) => {
      buffer.getChannelData(index).set(channel);
    });
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    source.start(start);
    this.sources.add(source);
    const end = start + length / rate;
    this.segments.push({ start, end, positionMs: block.positionMs });
    this.nextTime = end;
  }

  /**
   * Read the next block at the playback rate. At the loop end the block is cut short and
   * the reader reopens at the loop start. Returns `null` at the end of the track.
   */
  private async nextBlock(): Promise<Block | null> {
    for (;;) {
      const reader = this.reader;
      if (!reader || this.stopped) return null;
      const positionMs = this.producedPositionMs();
      const raw = await reader.read();
      if (this.stopped || reader !== this.reader) return null;
      if (!raw) {
        const tail = this.resampler.flush();
        this.reader.close();
        this.reader = null;
        return tail[0].length > 0 ? this.emitted(tail, positionMs) : null;
      }
      const remaining = this.framesUntilLoopEnd();
      if (remaining !== null && raw[0].length >= remaining) {
        const head = this.resampler.push(
          raw.map((channel) => channel.subarray(0, remaining)),
        );
        const tail = this.resampler.flush();
        const block = concatChannels(head, tail);
        this.openAt(this.loop!.start);
        if (block[0].length > 0) return { channels: block, positionMs };
        continue;
      }
      this.sourceFramesRead += raw[0].length;
      const output = this.resampler.push(raw);
      if (output[0].length > 0) return this.emitted(output, positionMs);
    }
  }

  /** Count resampled output and pair it with the position it started at. */
  private emitted(channels: Float32Array[], positionMs: number): Block {
    this.outputFrames += channels[0].length;
    return { channels, positionMs };
  }

  /** Source frames left before the loop end, or `null` when no loop end lies ahead. */
  private framesUntilLoopEnd(): number | null {
    const loop = this.loop;
    if (!loop || loop.end <= loop.start || this.openedAtMs >= loop.end) {
      return null;
    }
    const rate = this.track.sampleRate;
    const openedFrame = Math.round((this.openedAtMs / 1_000) * rate);
    // A loop end moved behind what was already read wraps right away.
    return Math.max(
      0,
      Math.round((loop.end / 1_000) * rate) -
        openedFrame -
        this.sourceFramesRead,
    );
  }

  /** Track position of the next sample the reader will produce. */
  private producedPositionMs(): number {
    return (
      this.openedAtMs + (this.outputFrames / this.context.sampleRate) * 1_000
    );
  }

  /** Replace the reader with one starting at `positionMs`. */
  private openAt(positionMs: number): void {
    this.reader?.close();
    const frame = Math.round((positionMs / 1_000) * this.track.sampleRate);
    this.openedAtMs = (frame / this.track.sampleRate) * 1_000;
    this.sourceFramesRead = 0;
    this.outputFrames = 0;
    this.resampler = this.createResampler();
    this.reader = this.track.openReader(frame);
  }

  /** A resampler from the track's rate to the playback rate. */
  private createResampler(): StreamResampler {
    return new StreamResampler(
      this.track.sampleRate,
      this.context.sampleRate,
      this.track.channelCount,
    );
  }

  /**
   * The first sample frame boundary the audio clock can still reach after a short margin,
   * so every block starts on a whole frame and plays without interpolation.
   */
  private earliestStartTime(): number {
    const rate = this.context.sampleRate;
    const frame = (this.context.currentTime + START_MARGIN_SECONDS) * rate;
    // Rounding error must not push an exact boundary to the next frame.
    return Math.ceil(frame - 1e-6) / rate;
  }

  /** Clamp a position to the track's length, when known. */
  private clampToTrack(positionMs: number): number {
    const durationMs = this.track.durationMs() ?? Number.POSITIVE_INFINITY;
    return Math.min(durationMs, Math.max(0, positionMs));
  }

  /** Release the voice without playing anything and tell the host there is nothing to play. */
  private giveUp(): void {
    this.ended = true;
    this.stop();
    this.options.onStart(null);
  }

  /** Stop the top-up timer. */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Join two planar blocks channel by channel. */
function concatChannels(
  head: Float32Array[],
  tail: Float32Array[],
): Float32Array[] {
  if (tail[0].length === 0) return head;
  return head.map((channel, index) => {
    const joined = new Float32Array(channel.length + tail[index].length);
    joined.set(channel);
    joined.set(tail[index], channel.length);
    return joined;
  });
}

/**
 * Time between scheduling a sample and hearing it. Safari reports no `outputLatency`, so
 * the base latency of the processing graph is the best available estimate there.
 */
export function outputLatencySeconds(context: AudioContext): number {
  return context.outputLatency || context.baseLatency || 0;
}
