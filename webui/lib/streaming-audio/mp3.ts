// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Samples of delay the MP3 decoder itself adds ahead of the encoded signal.
export const MP3_DECODER_DELAY = 529;

const MPEG1_BITRATES_KBPS = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MPEG2_BITRATES_KBPS = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
];
const MPEG1_SAMPLE_RATES = [44_100, 48_000, 32_000];

/** One parsed MPEG Layer III frame header. */
export interface Mp3FrameHeader {
  /** 1 for MPEG-1, 2 for MPEG-2 and 2.5. Frames of one stream share it. */
  version: 1 | 2;
  sampleRate: number;
  channelCount: number;
  /** Bytes in the whole frame, header included. */
  frameLength: number;
  samplesPerFrame: number;
}

/**
 * Parse the Layer III frame header at `offset`, returning `null` when the bytes there are
 * not a valid header. Layers I and II are rejected because WebCodecs only names Layer III.
 */
export function parseMp3FrameHeader(
  bytes: Uint8Array,
  offset: number,
): Mp3FrameHeader | null {
  if (offset + 4 > bytes.length) return null;
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0b11;
  const layerBits = (b1 >> 1) & 0b11;
  const bitrateIndex = b2 >> 4;
  const sampleRateIndex = (b2 >> 2) & 0b11;
  if (versionBits === 0b01 || layerBits !== 0b01) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }
  const mpeg1 = versionBits === 0b11;
  // MPEG-2 halves the MPEG-1 sample rates and MPEG-2.5 quarters them.
  const sampleRate =
    MPEG1_SAMPLE_RATES[sampleRateIndex] /
    (mpeg1 ? 1 : versionBits === 0b10 ? 2 : 4);
  const bitrate =
    (mpeg1 ? MPEG1_BITRATES_KBPS : MPEG2_BITRATES_KBPS)[bitrateIndex] * 1_000;
  const padding = (b2 >> 1) & 1;
  const samplesPerFrame = mpeg1 ? 1_152 : 576;
  return {
    version: mpeg1 ? 1 : 2,
    sampleRate,
    channelCount: bytes[offset + 3] >> 6 === 0b11 ? 1 : 2,
    frameLength:
      Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding,
    samplesPerFrame,
  };
}

/** Size of an ID3v2 tag at the start of `bytes`, or 0 when there is none. */
export function id3v2TagLength(bytes: Uint8Array): number {
  if (
    bytes.length < 10 ||
    bytes[0] !== 0x49 ||
    bytes[1] !== 0x44 ||
    bytes[2] !== 0x33
  ) {
    return 0;
  }
  // The size is a 28-bit "syncsafe" integer that excludes the header and optional footer.
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  const hasFooter = (bytes[5] & 0x10) !== 0;
  return 10 + size + (hasFooter ? 10 : 0);
}

/** What a Xing, Info or VBRI header frame says about the stream that follows it. */
export interface Mp3InfoFrame {
  /** Audio frames in the stream, excluding the info frame itself, when stated. */
  frameCount: number | null;
  /** Encoder delay and end padding from a LAME tag, used to trim to the exact audio. */
  gapless: { delay: number; padding: number } | null;
}

/**
 * Read the encoder information frame some encoders write first. It holds no audio and
 * must not be decoded or counted. Returns `null` for an ordinary audio frame.
 */
export function parseMp3InfoFrame(
  bytes: Uint8Array,
  offset: number,
  header: Mp3FrameHeader,
): Mp3InfoFrame | null {
  const end = offset + header.frameLength;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** Whether the four characters at `at`, inside this frame, spell `tag`. */
  const tagAt = (at: number, tag: string) =>
    at + 4 <= end &&
    at + 4 <= bytes.length &&
    String.fromCharCode(...bytes.subarray(at, at + 4)) === tag;

  if (tagAt(offset + 36, "VBRI")) {
    return {
      frameCount:
        offset + 36 + 18 <= bytes.length
          ? view.getUint32(offset + 36 + 14)
          : null,
      gapless: null,
    };
  }
  // The Xing tag follows the side information, whose size depends on version and channels.
  const sideInfoLength =
    header.version === 1
      ? header.channelCount === 1
        ? 17
        : 32
      : header.channelCount === 1
        ? 9
        : 17;
  const xing = offset + 4 + sideInfoLength;
  if (!tagAt(xing, "Xing") && !tagAt(xing, "Info")) return null;
  if (xing + 8 > bytes.length) return { frameCount: null, gapless: null };
  const flags = view.getUint32(xing + 4);
  let cursor = xing + 8;
  let frameCount: number | null = null;
  if (flags & 0x1) {
    frameCount = cursor + 4 <= bytes.length ? view.getUint32(cursor) : null;
    cursor += 4;
  }
  if (flags & 0x2) cursor += 4;
  if (flags & 0x4) cursor += 100;
  if (flags & 0x8) cursor += 4;
  // The LAME extension stores 12-bit encoder delay and padding 21 bytes in.
  const gaplessAt = cursor + 21;
  const gapless =
    tagAt(cursor, "LAME") || tagAt(cursor, "Lavc") || tagAt(cursor, "Lavf")
      ? gaplessAt + 3 <= Math.min(end, bytes.length)
        ? {
            delay: (bytes[gaplessAt] << 4) | (bytes[gaplessAt + 1] >> 4),
            padding:
              ((bytes[gaplessAt + 1] & 0x0f) << 8) | bytes[gaplessAt + 2],
          }
        : null
      : null;
  return { frameCount, gapless };
}

/** Whether `next` belongs to the same stream as `first`, guarding against false syncs. */
function sameStream(first: Mp3FrameHeader, next: Mp3FrameHeader): boolean {
  return (
    first.version === next.version &&
    first.sampleRate === next.sampleRate &&
    first.channelCount === next.channelCount
  );
}

/** Stream properties known once the first frame has been read. */
export interface Mp3StreamInfo {
  sampleRate: number;
  channelCount: number;
  samplesPerFrame: number;
  /** Decoded samples to drop at the start: encoder plus decoder delay, from a LAME tag. */
  startSkip: number;
  /**
   * Decoded samples to drop at the end, from a LAME tag. The decoder delay pushes the
   * encoder padding later, so this is the padding less that delay.
   */
  endTrim: number;
  /** Audio frame count announced by an info frame, before the scan has counted them. */
  announcedFrameCount: number | null;
}

/**
 * Frame table of one MP3 file, built incrementally from its bytes as they download. Only
 * frame offsets are kept, so a two hour file costs about a megabyte, and any frame can
 * be fetched by byte range for exact seeking.
 */
export class Mp3FrameIndex {
  info: Mp3StreamInfo | null = null;
  complete = false;
  private offsets = new Float64Array(4_096);
  private count = 0;
  private endOffset = 0;
  private first: Mp3FrameHeader | null = null;
  private carry = new Uint8Array(0);
  private carryStart = 0;
  private nextFrameAt = 0;
  private synced = false;
  private tagSkipped = false;
  private waiters: (() => void)[] = [];

  /** Number of audio frames found so far. */
  get frameCount(): number {
    return this.count;
  }

  /** Byte offset where audio frame `index` starts. */
  frameOffset(index: number): number {
    return this.offsets[index];
  }

  /** Byte offset just past audio frame `index`. */
  frameEnd(index: number): number {
    return index + 1 < this.count ? this.offsets[index + 1] : this.endOffset;
  }

  /**
   * Consume the next run of file bytes, which must follow the previous run directly, and
   * index every whole frame it completes.
   */
  push(chunk: Uint8Array): void {
    const bytes = new Uint8Array(this.carry.length + chunk.length);
    bytes.set(this.carry);
    bytes.set(chunk, this.carry.length);
    const base = this.carryStart;
    let at = Math.max(0, this.nextFrameAt - base);
    if (!this.tagSkipped) {
      // An ID3 tag can hold megabytes of cover art: skip it without keeping its bytes.
      if (bytes.length < 10) {
        this.keep(bytes, base, 0);
        return;
      }
      this.tagSkipped = true;
      at = id3v2TagLength(bytes);
    }
    const before = this.count;
    while (at + 4 <= bytes.length) {
      const header = parseMp3FrameHeader(bytes, at);
      const valid = header && (!this.first || sameStream(this.first, header));
      if (!header || !valid) {
        // Lost sync, e.g. trailing tags or damage: look for the next frame header.
        this.synced = false;
        at += 1;
        continue;
      }
      if (at + header.frameLength > bytes.length) break;
      if (!this.synced) {
        // A header found by searching must be followed by another to be trusted.
        if (at + header.frameLength + 4 > bytes.length) break;
        const following = parseMp3FrameHeader(bytes, at + header.frameLength);
        if (!following || !sameStream(this.first ?? header, following)) {
          at += 1;
          continue;
        }
      }
      this.synced = true;
      if (!this.first) {
        this.first = header;
        const infoFrame = parseMp3InfoFrame(bytes, at, header);
        this.info = {
          sampleRate: header.sampleRate,
          channelCount: header.channelCount,
          samplesPerFrame: header.samplesPerFrame,
          startSkip: infoFrame?.gapless
            ? infoFrame.gapless.delay + MP3_DECODER_DELAY
            : 0,
          endTrim: Math.max(
            0,
            (infoFrame?.gapless?.padding ?? 0) - MP3_DECODER_DELAY,
          ),
          announcedFrameCount: infoFrame?.frameCount ?? null,
        };
        if (infoFrame) {
          at += header.frameLength;
          continue;
        }
      }
      this.append(base + at, base + at + header.frameLength);
      at += header.frameLength;
    }
    this.nextFrameAt = base + at;
    this.keep(bytes, base, at);
    if (this.count !== before) this.notify();
  }

  /** Mark the end of the file, so readers stop waiting for frames that will never come. */
  finish(): void {
    this.complete = true;
    this.carry = new Uint8Array(0);
    this.notify();
  }

  /** Resolve once frame `index` is indexed or the whole file has been scanned. */
  async waitForFrame(index: number): Promise<void> {
    while (index >= this.count && !this.complete) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** Resolve once the stream's format is known, or the file turned out to have none. */
  async waitForInfo(): Promise<Mp3StreamInfo | null> {
    while (!this.info && !this.complete) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.info;
  }

  /** Playable sample count after gapless trimming, or `null` while it is still unknown. */
  totalSamples(): number | null {
    const info = this.info;
    if (!info) return this.complete ? 0 : null;
    const frames = this.complete ? this.count : info.announcedFrameCount;
    if (frames === null) return null;
    return Math.max(
      0,
      frames * info.samplesPerFrame - info.startSkip - info.endTrim,
    );
  }

  /** Record one audio frame's byte range. */
  private append(start: number, end: number): void {
    if (this.count === this.offsets.length) {
      const grown = new Float64Array(this.offsets.length * 2);
      grown.set(this.offsets);
      this.offsets = grown;
    }
    this.offsets[this.count] = start;
    this.count += 1;
    this.endOffset = end;
  }

  /**
   * Hold the unparsed tail of `bytes` from `from` until the next chunk completes it.
   * When `from` lies past the end, e.g. inside a tag being skipped, nothing is held.
   */
  private keep(bytes: Uint8Array, base: number, from: number): void {
    const start = Math.min(from, bytes.length);
    this.carry = bytes.slice(start);
    this.carryStart = base + start;
  }

  /** Wake everything waiting on new frames. */
  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}
