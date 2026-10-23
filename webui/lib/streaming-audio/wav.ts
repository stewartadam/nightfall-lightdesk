// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Layout of the uncompressed samples in a WAV file. */
export interface WavFormat {
  sampleRate: number;
  channelCount: number;
  /** Bytes per sample frame across all channels. */
  blockAlign: number;
  bitsPerSample: number;
  float: boolean;
  /** Byte offset where sample data starts. */
  dataOffset: number;
  /** Bytes of sample data, clamped to what the file holds. */
  dataLength: number;
}

/** Read a four character chunk id. */
function fourCc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}

/**
 * Parse a RIFF WAVE header from the start of a file of `fileLength` bytes. Returns
 * `null` when the bytes are not a WAV file this reader can stream, or when the header
 * does not fit in `bytes`.
 */
export function parseWavHeader(
  bytes: Uint8Array,
  fileLength: number,
): WavFormat | null {
  if (
    bytes.length < 12 ||
    fourCc(bytes, 0) !== "RIFF" ||
    fourCc(bytes, 8) !== "WAVE"
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: Omit<WavFormat, "dataOffset" | "dataLength"> | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = fourCc(bytes, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      let tag = view.getUint16(body, true);
      if (tag === WAVE_FORMAT_EXTENSIBLE && body + 26 <= bytes.length) {
        tag = view.getUint16(body + 24, true);
      }
      const bitsPerSample = view.getUint16(body + 14, true);
      const float = tag === WAVE_FORMAT_FLOAT;
      const supported = float
        ? bitsPerSample === 32 || bitsPerSample === 64
        : tag === WAVE_FORMAT_PCM && [8, 16, 24, 32].includes(bitsPerSample);
      if (!supported) return null;
      format = {
        channelCount: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample,
        float,
      };
    } else if (id === "data") {
      if (!format || format.blockAlign === 0) return null;
      // Streamed recordings may leave the size unset, so trust the file length instead.
      const available = fileLength - body;
      const declared = size === 0 || size === 0xffffffff ? available : size;
      const dataLength =
        Math.floor(Math.min(declared, available) / format.blockAlign) *
        format.blockAlign;
      return { ...format, dataOffset: body, dataLength };
    }
    // Chunks are padded to an even size.
    at = body + size + (size & 1);
  }
  return null;
}

/** Convert whole interleaved sample frames into one float array per channel. */
export function decodeWavSamples(
  format: WavFormat,
  bytes: Uint8Array,
): Float32Array[] {
  const frames = Math.floor(bytes.length / format.blockAlign);
  const channels = Array.from(
    { length: format.channelCount },
    () => new Float32Array(frames),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bytesPerSample = format.bitsPerSample / 8;
  /** Read one sample as a float in [-1, 1]. */
  const read = (at: number): number => {
    if (format.float) {
      return format.bitsPerSample === 32
        ? view.getFloat32(at, true)
        : view.getFloat64(at, true);
    }
    switch (format.bitsPerSample) {
      case 8:
        return (view.getUint8(at) - 128) / 128;
      case 16:
        return view.getInt16(at, true) / 32_768;
      case 24:
        return (
          (view.getUint8(at) |
            (view.getUint8(at + 1) << 8) |
            (view.getInt8(at + 2) << 16)) /
          8_388_608
        );
      default:
        return view.getInt32(at, true) / 2_147_483_648;
    }
  };
  for (let frame = 0; frame < frames; frame += 1) {
    const frameAt = frame * format.blockAlign;
    for (let channel = 0; channel < format.channelCount; channel += 1) {
      channels[channel][frame] = read(frameAt + channel * bytesPerSample);
    }
  }
  return channels;
}
