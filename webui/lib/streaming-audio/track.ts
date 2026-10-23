// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getLogger } from "../logger";
import { id3v2TagLength, Mp3FrameIndex, type Mp3StreamInfo } from "./mp3";
import { decodeWavSamples, parseWavHeader, type WavFormat } from "./wav";

const log = getLogger(import.meta.url);

// Bytes read up front to identify the format and parse headers.
const PROBE_BYTES = 64 * 1_024;
// Frames decoded before a seek target so the decoder's overlap and bit reservoir are
// filled in, and discarded. The bit reservoir reaches back at most 511 bytes, which is
// under ten frames even at the lowest bitrates.
const MP3_PREROLL_FRAMES = 10;
// Compressed frames fetched per byte-range request, about a second of audio.
const MP3_FRAMES_PER_FETCH = 40;
// Compressed frames handed to the decoder ahead of the samples taken out of it.
const MP3_MAX_DECODE_QUEUE = MP3_FRAMES_PER_FETCH * 2;
// Uncompressed sample frames read per byte-range request from a WAV file.
const WAV_FRAMES_PER_READ = 32_768;
// Sample frames handed out per read from audio decoded in memory.
const BUFFER_FRAMES_PER_READ = 32_768;

/** Reads planar samples sequentially from a fixed starting point in a track. */
export interface PcmReader {
  /** The next block of samples, one array per channel, or `null` at the end of the audio. */
  read(): Promise<Float32Array[] | null>;
  /** Stop reading and release decoder and network resources. */
  close(): void;
}

/**
 * An audio file opened for random access. Only metadata is held; samples are produced
 * on demand by readers, so memory does not grow with the file's length.
 */
export interface AudioTrack {
  readonly sampleRate: number;
  readonly channelCount: number;
  /** Playable length in milliseconds, or `null` while the file is still being indexed. */
  durationMs(): number | null;
  /** Start reading at sample frame `startFrame` of the source. */
  openReader(startFrame: number): PcmReader;
  /** Release everything the track holds, including any download still indexing it. */
  close(): void;
}

/** Random access to the bytes of an audio file. */
interface ByteSource {
  /** File size in bytes, or `null` while a download without a stated size is running. */
  readonly length: number | null;
  /** Bytes `[start, end)`, cut short at the end of the file. */
  read(start: number, end: number): Promise<Uint8Array>;
  /**
   * Pass the whole file to `onChunk` in order, then call `onDone`, without keeping the
   * bytes. Used to index MP3 frames.
   */
  scan(onChunk: (chunk: Uint8Array) => void, onDone: () => void): void;
  /** Cancel downloads and release memory. */
  close(): void;
}

/** Total file size from a `Content-Range: bytes a-b/size` header, if stated. */
function contentRangeSize(response: Response): number | null {
  const match = /\/(\d+)\s*$/.exec(response.headers.get("Content-Range") ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * A file read with HTTP byte-range requests, so only the bytes being played are ever in
 * memory. `head` holds the first bytes, already fetched.
 */
class RangeByteSource implements ByteSource {
  private readonly abort = new AbortController();

  /** Wrap a server that answered the first range request with a known file size. */
  constructor(
    private readonly url: string,
    readonly length: number,
    private readonly head: Uint8Array,
  ) {}

  /** Fetch one byte range. */
  async read(start: number, end: number): Promise<Uint8Array> {
    const until = Math.min(end, this.length);
    if (until <= start) return new Uint8Array(0);
    const response = await this.fetchRange(start, until);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Download the rest of the file after the head in the background. */
  scan(onChunk: (chunk: Uint8Array) => void, onDone: () => void): void {
    onChunk(this.head);
    if (this.head.length >= this.length) {
      onDone();
      return;
    }
    void (async () => {
      try {
        const response = await this.fetchRange(this.head.length);
        const reader = response.body?.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          onChunk(value);
        }
      } catch (error) {
        if (!this.abort.signal.aborted) {
          log.warn("Unable to index timeline audio", error);
        }
      } finally {
        onDone();
      }
    })();
  }

  /** Cancel the background download. */
  close(): void {
    this.abort.abort();
  }

  /** Request `[start, end)`, or to the end of the file, insisting on a range answer. */
  private async fetchRange(start: number, end?: number): Promise<Response> {
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end === undefined ? "" : end - 1}` },
      signal: this.abort.signal,
    });
    if (response.status !== 206) {
      void response.body?.cancel();
      throw new Error(`Byte-range request answered with ${response.status}`);
    }
    return response;
  }
}

/**
 * A whole file downloaded into memory, for servers that ignore byte-range requests. Only
 * the compressed file is held, which for MP3 is about a megabyte per minute; reads wait
 * for the download to reach the bytes they need.
 */
class DownloadedByteSource implements ByteSource {
  length: number | null;
  private bytes: Uint8Array;
  private received = 0;
  private done = false;
  private failure: unknown = null;
  private waiters: (() => void)[] = [];
  private listener: ((chunk: Uint8Array) => void) | null = null;
  private onDone: (() => void) | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  /** Start reading `response`'s body into memory. */
  constructor(response: Response) {
    const stated = Number(response.headers.get("Content-Length"));
    this.length = Number.isFinite(stated) && stated > 0 ? stated : null;
    this.bytes = new Uint8Array(this.length ?? 1_024 * 1_024);
    this.reader = response.body?.getReader() ?? null;
    void this.download();
  }

  /** Wait until the download covers `[start, end)` or ends, then copy those bytes. */
  async read(start: number, end: number): Promise<Uint8Array> {
    while (this.received < end && !this.done) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.failure) throw this.failure;
    return this.bytes.slice(start, Math.min(end, this.received));
  }

  /** Pass what has arrived so far, then each chunk as it arrives. */
  scan(onChunk: (chunk: Uint8Array) => void, onDone: () => void): void {
    onChunk(this.bytes.subarray(0, this.received));
    if (this.done) {
      onDone();
      return;
    }
    this.listener = onChunk;
    this.onDone = onDone;
  }

  /** Stop downloading and drop the bytes. */
  close(): void {
    void this.reader?.cancel();
    this.bytes = new Uint8Array(0);
    this.finish();
  }

  /** Copy the body into memory, growing the buffer when the size was not stated. */
  private async download(): Promise<void> {
    try {
      while (this.reader) {
        const { done, value } = await this.reader.read();
        if (done) break;
        if (this.received + value.length > this.bytes.length) {
          const grown = new Uint8Array(
            Math.max(this.bytes.length * 2, this.received + value.length),
          );
          grown.set(this.bytes.subarray(0, this.received));
          this.bytes = grown;
        }
        this.bytes.set(value, this.received);
        this.received += value.length;
        this.listener?.(value);
        this.wakeReaders();
      }
    } catch (error) {
      this.failure = error;
      log.warn("Unable to download timeline audio", error);
    } finally {
      this.length = this.received;
      this.finish();
    }
  }

  /** Mark the download as over and wake everything waiting on it. */
  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.onDone?.();
    this.listener = null;
    this.wakeReaders();
  }

  /** Wake reads waiting for more bytes. */
  private wakeReaders(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

/** Create a promise with its resolve function exposed. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * An MP3 file played frame by frame: a scan of the whole file indexes every frame's
 * offset while discarding the bytes, and readers fetch and decode only the frames they
 * need through WebCodecs.
 */
class Mp3Track implements AudioTrack {
  readonly sampleRate: number;
  readonly channelCount: number;

  /** Wrap an index whose stream format is already known. */
  constructor(
    private readonly source: ByteSource,
    private readonly index: Mp3FrameIndex,
    private readonly info: Mp3StreamInfo,
  ) {
    this.sampleRate = info.sampleRate;
    this.channelCount = info.channelCount;
  }

  /** Length after gapless trimming, once the scan or an info frame has counted the frames. */
  durationMs(): number | null {
    const samples = this.index.totalSamples();
    return samples === null ? null : (samples / this.sampleRate) * 1_000;
  }

  /** Read from `startFrame`, decoding from a few frames earlier and discarding those. */
  openReader(startFrame: number): PcmReader {
    return new Mp3Reader(
      this.source,
      this.index,
      this.info,
      startFrame + this.info.startSkip,
    );
  }

  /** Stop the scan and release the file. */
  close(): void {
    this.source.close();
  }
}

/**
 * Decodes MP3 frames fetched by byte range, producing samples from an exact decoded
 * sample index. Decoder output order is the input order, and each output's timestamp
 * names its first decoded sample.
 */
class Mp3Reader implements PcmReader {
  private decoder: AudioDecoder;
  private nextFrame: number;
  private output: Float32Array[][] = [];
  private failure: unknown = null;
  private wake = signal();
  private flushed = false;
  private closed = false;

  /**
   * Start decoding so the first sample returned is decoded sample `decodedStart`, where
   * decoded samples count from the first audio frame and include the start skip.
   */
  constructor(
    private readonly source: ByteSource,
    private readonly index: Mp3FrameIndex,
    private readonly info: Mp3StreamInfo,
    private decodedStart: number,
  ) {
    const targetFrame = Math.floor(decodedStart / info.samplesPerFrame);
    this.nextFrame = Math.max(0, targetFrame - MP3_PREROLL_FRAMES);
    this.decoder = new AudioDecoder({
      output: (data) => this.accept(data),
      error: (error) => {
        this.failure = error;
        this.wake.resolve();
      },
    });
    this.decoder.addEventListener("dequeue", () => this.wake.resolve());
    this.decoder.configure(mp3DecoderConfig(info));
  }

  /** Return decoded samples once available, feeding the decoder as it drains. */
  async read(): Promise<Float32Array[] | null> {
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.closed) return null;
      const block = this.output.shift();
      if (block) return block;
      if (this.flushed) return null;
      const woken = this.wake.promise;
      if (this.decoder.decodeQueueSize < MP3_MAX_DECODE_QUEUE) {
        await this.feed();
        continue;
      }
      await woken;
      this.wake = signal();
    }
  }

  /** Stop decoding. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.output = [];
    if (this.decoder.state !== "closed") this.decoder.close();
    this.wake.resolve();
  }

  /** Fetch and queue the next run of frames, or flush the decoder at the end of the file. */
  private async feed(): Promise<void> {
    const first = this.nextFrame;
    await this.index.waitForFrame(first + MP3_FRAMES_PER_FETCH - 1);
    if (this.closed) return;
    const last = Math.min(first + MP3_FRAMES_PER_FETCH, this.index.frameCount);
    if (first >= last) {
      // Every frame has been queued: drain what the decoder still holds.
      if (this.decoder.state === "configured") await this.decoder.flush();
      this.flushed = true;
      return;
    }
    const base = this.index.frameOffset(first);
    const bytes = await this.source.read(base, this.index.frameEnd(last - 1));
    if (this.closed) return;
    for (let frame = first; frame < last; frame += 1) {
      const start = this.index.frameOffset(frame) - base;
      const end = this.index.frameEnd(frame) - base;
      this.decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: this.sampleToMicros(frame * this.info.samplesPerFrame),
          data: bytes.subarray(start, end),
        }),
      );
    }
    this.nextFrame = last;
  }

  /** Keep the part of one decoded output inside the playable range. */
  private accept(data: AudioData): void {
    try {
      if (this.closed) return;
      const first = Math.round((data.timestamp * data.sampleRate) / 1_000_000);
      const total = this.index.totalSamples();
      const end =
        total === null ? Number.POSITIVE_INFINITY : total + this.info.startSkip;
      const from = Math.max(0, this.decodedStart - first);
      const to = Math.min(data.numberOfFrames, end - first);
      if (to <= from) return;
      const channels: Float32Array[] = [];
      for (let plane = 0; plane < data.numberOfChannels; plane += 1) {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: plane, format: "f32-planar" });
        channels.push(samples.subarray(from, to));
      }
      // Later outputs continue from here even if a frame produced nothing.
      this.decodedStart = first + to;
      this.output.push(channels);
    } finally {
      data.close();
      this.wake.resolve();
    }
  }

  /** Express a decoded sample index as a WebCodecs timestamp. */
  private sampleToMicros(sample: number): number {
    return Math.round((sample * 1_000_000) / this.info.sampleRate);
  }
}

/** WebCodecs decoder configuration for an MP3 stream. */
function mp3DecoderConfig(info: Mp3StreamInfo): AudioDecoderConfig {
  return {
    codec: "mp3",
    sampleRate: info.sampleRate,
    numberOfChannels: info.channelCount,
  };
}

/** A WAV file read in fixed size pieces, converting samples as they are read. */
class WavTrack implements AudioTrack {
  readonly sampleRate: number;
  readonly channelCount: number;

  /** Wrap a parsed header for the file in `source`. */
  constructor(
    private readonly source: ByteSource,
    private readonly format: WavFormat,
  ) {
    this.sampleRate = format.sampleRate;
    this.channelCount = format.channelCount;
  }

  /** Length of the sample data. */
  durationMs(): number {
    const frames = this.format.dataLength / this.format.blockAlign;
    return (frames / this.sampleRate) * 1_000;
  }

  /** Read sample frames from `startFrame` in fixed size byte ranges. */
  openReader(startFrame: number): PcmReader {
    const { blockAlign, dataOffset, dataLength } = this.format;
    let at = dataOffset + Math.max(0, Math.floor(startFrame)) * blockAlign;
    const end = dataOffset + dataLength;
    let closed = false;
    return {
      /** Fetch and convert the next run of sample frames. */
      read: async () => {
        if (closed || at >= end) return null;
        const until = Math.min(end, at + WAV_FRAMES_PER_READ * blockAlign);
        const bytes = await this.source.read(at, until);
        at = until;
        // A file shorter than its header claims ends early.
        if (closed || bytes.length < blockAlign) return null;
        return decodeWavSamples(this.format, bytes);
      },
      /** End reading; a read in flight returns nothing. */
      close: () => {
        closed = true;
      },
    };
  }

  /** Release the file. */
  close(): void {
    this.source.close();
  }
}

/**
 * Audio decoded into memory in one piece. Used for formats and browsers that cannot be
 * streamed, at the cost of memory proportional to the audio's length.
 */
export class DecodedBufferTrack implements AudioTrack {
  readonly sampleRate: number;
  readonly channelCount: number;

  /** Wrap a decoded buffer. */
  constructor(private readonly buffer: AudioBuffer) {
    this.sampleRate = buffer.sampleRate;
    this.channelCount = buffer.numberOfChannels;
  }

  /** Length of the decoded audio. */
  durationMs(): number {
    return this.buffer.duration * 1_000;
  }

  /** Hand out the decoded samples from `startFrame` in fixed size views. */
  openReader(startFrame: number): PcmReader {
    let at = Math.max(0, Math.floor(startFrame));
    let closed = false;
    return {
      /** Hand out a view of the next run of decoded sample frames. */
      read: async () => {
        if (closed || at >= this.buffer.length) return null;
        const until = Math.min(this.buffer.length, at + BUFFER_FRAMES_PER_READ);
        const block = Array.from({ length: this.channelCount }, (_, channel) =>
          this.buffer.getChannelData(channel).subarray(at, until),
        );
        at = until;
        return block;
      },
      /** End reading. */
      close: () => {
        closed = true;
      },
    };
  }

  /** The buffer is released with the track. */
  close(): void {}
}

/** Whether this browser's WebCodecs can decode the MP3 stream described by `info`. */
async function canDecode(info: Mp3StreamInfo): Promise<boolean> {
  if (typeof AudioDecoder === "undefined") return false;
  try {
    const support = await AudioDecoder.isConfigSupported(
      mp3DecoderConfig(info),
    );
    return support.supported === true;
  } catch {
    return false;
  }
}

/**
 * Request the first bytes of `url` as a byte range. A server that honours it is read by
 * range from then on; one that sends the whole file instead is downloaded into memory.
 * Returns the source and the first bytes, which identify the format.
 */
async function openByteSource(
  url: string,
): Promise<{ source: ByteSource; head: Uint8Array }> {
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
  });
  if (!response.ok) {
    throw new Error(`Unable to fetch timeline audio (${response.status})`);
  }
  const length = contentRangeSize(response);
  if (response.status === 206 && length !== null) {
    const head = new Uint8Array(await response.arrayBuffer());
    return { source: new RangeByteSource(url, length, head), head };
  }
  let whole = response;
  if (response.status === 206) {
    // A range answer without the file size cannot be read by range; fetch it whole.
    void response.body?.cancel();
    whole = await fetch(url);
    if (!whole.ok) {
      throw new Error(`Unable to fetch timeline audio (${whole.status})`);
    }
  }
  const source = new DownloadedByteSource(whole);
  return { source, head: await source.read(0, PROBE_BYTES) };
}

/**
 * Open `url` for streaming when its format and the browser allow it: MP3 through
 * WebCodecs, or WAV. Returns `null` when the file has to be decoded whole instead, e.g.
 * for AAC or without WebCodecs.
 */
export async function openStreamingTrack(
  url: string,
): Promise<AudioTrack | null> {
  const { source, head } = await openByteSource(url);
  const wav = parseWavHeader(head, source.length ?? Number.POSITIVE_INFINITY);
  if (wav) return new WavTrack(source, wav);

  const sniffed = new Mp3FrameIndex();
  sniffed.push(head);
  // Anything else, e.g. AAC, shows no MP3 frame in its first bytes unless a long ID3 tag
  // (cover art) pushes the first frame further in.
  if (
    (!sniffed.info && id3v2TagLength(head) <= head.length) ||
    (sniffed.info && !(await canDecode(sniffed.info)))
  ) {
    source.close();
    return null;
  }
  const scanned = new Mp3FrameIndex();
  source.scan(
    (chunk) => scanned.push(chunk),
    () => scanned.finish(),
  );
  const info = await scanned.waitForInfo();
  if (!info || !(await canDecode(info))) {
    source.close();
    return null;
  }
  return new Mp3Track(source, scanned, info);
}
