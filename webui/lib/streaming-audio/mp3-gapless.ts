// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Samples of delay the MP3 decoder itself adds ahead of the encoded signal.
export const MP3_DECODER_DELAY = 529;
// Longest possible Layer III frame: MPEG-1 at 320 kbps and 32 kHz, with padding.
const MAX_FRAME_BYTES = 1_441;
// Bytes searched for the first frame after the ID3 tags.
const SYNC_SEARCH_BYTES = 4_096;

/**
 * Samples to drop from decoded MP3 audio so it matches the encoder's input exactly, as
 * the native engine and `decodeAudioData` do.
 */
export interface Mp3Gapless {
  /** Decoded samples to drop at the start: encoder plus decoder delay. */
  startSkip: number;
  /** Decoded samples to drop at the end: encoder padding not covered by the decoder delay. */
  endTrim: number;
}

/** Size of an ID3v2 tag at the start of `bytes`, or 0 when there is none. */
function id3v2TagLength(bytes: Uint8Array): number {
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

/**
 * Offset of the Xing or Info tag inside the Layer III frame starting at `offset`, which
 * follows the side information whose size depends on the MPEG version and channel mode.
 * Returns `null` when no frame header starts there.
 */
function xingTagOffset(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  const b1 = bytes[offset + 1];
  if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0b11;
  const layerBits = (b1 >> 1) & 0b11;
  if (versionBits === 0b01 || layerBits !== 0b01) return null;
  const mono = bytes[offset + 3] >> 6 === 0b11;
  const sideInfoLength =
    versionBits === 0b11 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return offset + 4 + sideInfoLength;
}

/**
 * Read the encoder delay and padding that LAME and ffmpeg record in the info frame at the
 * start of an MP3 file. The info frame holds no audio, and demuxers skip it, so this is
 * the only place the values live. `read(end)` returns the file's bytes from its start to
 * at least `end`, or fewer at the end of the file. Returns `null` when the file has no
 * such record, in which case the decoded audio is played untrimmed.
 */
export async function readMp3Gapless(
  read: (end: number) => Promise<Uint8Array>,
): Promise<Mp3Gapless | null> {
  let offset = 0;
  let bytes = await read(10);
  // Tags can be stacked.
  for (;;) {
    const tag = id3v2TagLength(bytes.subarray(offset));
    if (tag === 0) break;
    offset += tag;
    bytes = await read(offset + 10);
  }
  // Taggers can leave padding before the first frame, so search for it as demuxers do.
  bytes = await read(offset + SYNC_SEARCH_BYTES + MAX_FRAME_BYTES);
  let xing: number | null = null;
  for (
    let at = offset;
    xing === null && at < offset + SYNC_SEARCH_BYTES;
    at += 1
  ) {
    xing = xingTagOffset(bytes, at);
  }
  if (xing === null) return null;
  /** Whether the four characters at `at` spell `tag`. */
  const tagAt = (at: number, tag: string) =>
    at + 4 <= bytes.length &&
    String.fromCharCode(...bytes.subarray(at, at + 4)) === tag;
  if (
    (!tagAt(xing, "Xing") && !tagAt(xing, "Info")) ||
    xing + 8 > bytes.length
  ) {
    return null;
  }
  const flags = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(xing + 4);
  // Skip the optional frame count, byte count, seek table and quality fields.
  let cursor = xing + 8;
  if (flags & 0x1) cursor += 4;
  if (flags & 0x2) cursor += 4;
  if (flags & 0x4) cursor += 100;
  if (flags & 0x8) cursor += 4;
  if (
    !tagAt(cursor, "LAME") &&
    !tagAt(cursor, "Lavc") &&
    !tagAt(cursor, "Lavf")
  ) {
    return null;
  }
  // The LAME extension stores 12-bit encoder delay and padding 21 bytes in.
  const at = cursor + 21;
  if (at + 3 > bytes.length) return null;
  const delay = (bytes[at] << 4) | (bytes[at + 1] >> 4);
  const padding = ((bytes[at + 1] & 0x0f) << 8) | bytes[at + 2];
  return {
    startSkip: delay + MP3_DECODER_DELAY,
    endTrim: Math.max(0, padding - MP3_DECODER_DELAY),
  };
}
