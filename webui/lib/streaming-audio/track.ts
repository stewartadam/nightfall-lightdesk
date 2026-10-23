// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  ALL_FORMATS,
  type AudioSample,
  AudioSampleSink,
  Input,
  type InputAudioTrack,
  type Source,
  UrlSource,
} from "mediabunny";
import { getLogger } from "../logger";
import { type Mp3Gapless, readMp3Gapless } from "./mp3-gapless";

const log = getLogger(import.meta.url);

// Bytes requested up front to learn whether the server honours byte ranges, kept for
// reading the MP3 gapless record.
const HEAD_BYTES = 64 * 1_024;
// Compressed bytes mediabunny may cache while reading a file by byte range.
const RANGE_CACHE_BYTES = 8 * 1_024 * 1_024;
// Audio decoded before a seek target and discarded, so the decoder's overlap and the MP3
// bit reservoir are filled in. The reservoir reaches back under ten frames, or 0.27 s.
const PREROLL_SECONDS = 0.3;
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
  /** Playable length in milliseconds, or `null` when the file does not state it. */
  durationMs(): number | null;
  /** Start reading at sample frame `startFrame` of the source. */
  openReader(startFrame: number): PcmReader;
  /** Release everything the track holds, including any download in progress. */
  close(): void;
}

/** The first bytes of a file, kept only while the track is being opened. */
interface FileHead {
  /** Bytes from the start of the file to at least `end`, or fewer at the end of the file. */
  read(end: number): Promise<Uint8Array>;
  /** Drop the bytes and stop any download feeding them. */
  close(): void;
}

/** Join two byte arrays into one. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

/** The head of a file read by byte range, fetching more by range when asked past it. */
function rangeHead(url: string, head: Uint8Array, length: number): FileHead {
  let bytes = head;
  return {
    /** Fetch the missing bytes up to `end`, e.g. past a long ID3 tag with cover art. */
    read: async (end) => {
      const until = Math.min(end, length);
      if (bytes.length < until) {
        const response = await fetch(url, {
          headers: { Range: `bytes=${bytes.length}-${until - 1}` },
        });
        if (response.status !== 206) {
          void response.body?.cancel();
          throw new Error(
            `Byte-range request answered with ${response.status}`,
          );
        }
        bytes = concat(bytes, new Uint8Array(await response.arrayBuffer()));
      }
      return bytes;
    },
    /** Drop the bytes. */
    close: () => {
      bytes = new Uint8Array(0);
    },
  };
}

/**
 * The head of a file from a response that is not a byte range, read only as far as
 * needed. Closing cancels the rest of the response.
 */
function streamHead(stream: ReadableStream<Uint8Array>): FileHead {
  const reader = stream.getReader();
  let bytes: Uint8Array = new Uint8Array(0);
  let done = false;
  return {
    /** Read chunks until `end` is covered or the body ends. */
    read: async (end) => {
      while (!done && bytes.length < end) {
        const chunk = await reader.read();
        if (chunk.done) done = true;
        else bytes = concat(bytes, chunk.value);
      }
      return bytes;
    },
    /** Stop reading the response. */
    close: () => {
      bytes = new Uint8Array(0);
      void reader.cancel();
    },
  };
}

/** Total file size from a `Content-Range: bytes a-b/size` header, if stated. */
function contentRangeSize(response: Response): number | null {
  const match = /\/(\d+)\s*$/.exec(response.headers.get("Content-Range") ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Request the first bytes of `url` as a byte range. A server that honours it is read by
 * range from then on, with a small cache. For one that sends the whole file instead,
 * that response is kept in memory as it downloads: compressed audio is about a megabyte
 * per minute, and a server that ignores ranges cannot serve a seek back any other way.
 */
async function openSource(
  url: string,
): Promise<{ source: Source; head: FileHead }> {
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
  });
  if (!response.ok) {
    throw new Error(`Unable to fetch timeline audio (${response.status})`);
  }
  const length = contentRangeSize(response);
  if (response.status === 206 && length !== null) {
    const head = new Uint8Array(await response.arrayBuffer());
    return {
      source: new UrlSource(url, { maxCacheSize: RANGE_CACHE_BYTES }),
      head: rangeHead(url, head, length),
    };
  }
  if (!response.body) throw new Error("Timeline audio response has no body");
  // mediabunny makes its own request, learns the file size from it and falls back to
  // reading it sequentially; this response only supplies the first bytes.
  return {
    source: new UrlSource(url, { maxCacheSize: Number.POSITIVE_INFINITY }),
    head: streamHead(response.body),
  };
}

/**
 * A file demuxed and decoded by mediabunny, which reads only the bytes it needs and
 * decodes them with WebCodecs. Positions here count decoded samples from the track's
 * time zero; `startSkip` of them precede the playable audio.
 */
class MediabunnyTrack implements AudioTrack {
  readonly sampleRate: number;
  readonly channelCount: number;

  /**
   * Wrap an opened track. `endSample` is the decoded sample where the playable audio
   * ends, or `null` to play to the end of the file; `lengthSamples` is the playable
   * length when the file states it.
   */
  constructor(
    private readonly input: Input,
    private readonly track: InputAudioTrack,
    private readonly startSkip: number,
    private readonly endSample: number | null,
    private readonly lengthSamples: number | null,
  ) {
    this.sampleRate = track.sampleRate;
    this.channelCount = track.numberOfChannels;
  }

  /** Playable length from the file's metadata, after gapless trimming. */
  durationMs(): number | null {
    return this.lengthSamples === null
      ? null
      : (this.lengthSamples / this.sampleRate) * 1_000;
  }

  /** Read from `startFrame`, decoding from slightly earlier and discarding that part. */
  openReader(startFrame: number): PcmReader {
    return new MediabunnyReader(
      new AudioSampleSink(this.track),
      Math.max(0, Math.floor(startFrame)) + this.startSkip,
      this.endSample ?? Number.POSITIVE_INFINITY,
      this.sampleRate,
    );
  }

  /** Cancel downloads and release the file. */
  close(): void {
    this.input.dispose();
  }
}

/** Takes samples out of mediabunny's decoded stream from an exact sample onward. */
class MediabunnyReader implements PcmReader {
  private readonly samples: AsyncGenerator<AudioSample, void, unknown>;
  private closed = false;

  /**
   * Start decoding so the first sample returned is decoded sample `next`, and stop
   * before decoded sample `end`.
   */
  constructor(
    sink: AudioSampleSink,
    private next: number,
    private readonly end: number,
    private readonly sampleRate: number,
  ) {
    this.samples = sink.samples(
      Math.max(0, next / sampleRate - PREROLL_SECONDS),
    );
  }

  /** The next decoded block, trimmed to the requested range. */
  async read(): Promise<Float32Array[] | null> {
    while (!this.closed && this.next < this.end) {
      const { done, value: sample } = await this.samples.next();
      if (done) return null;
      try {
        if (this.closed) return null;
        const first = Math.round(sample.timestamp * this.sampleRate);
        const from = Math.max(0, this.next - first);
        const to = Math.min(sample.numberOfFrames, this.end - first);
        if (to <= from) continue;
        const channels: Float32Array[] = [];
        for (let plane = 0; plane < sample.numberOfChannels; plane += 1) {
          const samples = new Float32Array(to - from);
          sample.copyTo(samples, {
            planeIndex: plane,
            format: "f32-planar",
            frameOffset: from,
            frameCount: to - from,
          });
          channels.push(samples);
        }
        // Later samples continue from here even if the decoder skipped some.
        this.next = first + to;
        return channels;
      } finally {
        sample.close();
      }
    }
    return null;
  }

  /** Stop decoding; mediabunny closes its decoder when the iteration ends. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Cleanup can fail once the track's input is disposed, which is harmless here.
    this.samples.return().catch(() => undefined);
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

/**
 * Read the MP3 gapless record from the file's first bytes. A failure only costs the
 * trimming, so it is logged and streaming goes ahead untrimmed.
 */
async function readGapless(head: FileHead): Promise<Mp3Gapless | null> {
  try {
    return await readMp3Gapless((end) => head.read(end));
  } catch (error) {
    log.warn("Unable to read MP3 gapless info; playing untrimmed", error);
    return null;
  }
}

/**
 * Open `url` for streaming through mediabunny when its format and the browser's
 * WebCodecs allow it. MP3 files are trimmed by their gapless record so they line up
 * with the native engine. Returns `null` when the file has to be decoded whole instead.
 */
export async function openStreamingTrack(
  url: string,
): Promise<AudioTrack | null> {
  const { source, head } = await openSource(url);
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      return null;
    }
    const gapless =
      (await track.getCodec()) === "mp3" ? await readGapless(head) : null;
    const startSkip = gapless?.startSkip ?? 0;
    const seconds = await track.getDurationFromMetadata();
    const decoded =
      seconds === null ? null : Math.round(seconds * track.sampleRate);
    // Without a gapless record the stated length can be an estimate (constant bitrate
    // MP3), so it is not used to cut the audio short.
    const endSample =
      gapless && decoded !== null ? decoded - gapless.endTrim : null;
    const length = decoded === null ? null : (endSample ?? decoded) - startSkip;
    return new MediabunnyTrack(input, track, startSkip, endSample, length);
  } catch (error) {
    log.debug("Unable to stream timeline audio", error);
    input.dispose();
    return null;
  } finally {
    head.close();
  }
}
