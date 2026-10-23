// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Report whether a byte buffer starts with the gzip member header. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Return the unpacked bytes of a gzip body, or the body itself when it lacks
 * the gzip header (a host that served it with `Content-Encoding: gzip` has
 * already decoded it). Inflation aborts as soon as the unpacked size passes
 * `maxBytes`, so a small archive cannot expand without bound.
 */
export async function inflateGzipBounded(
  body: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!isGzip(body)) {
    if (body.byteLength > maxBytes) {
      throw new Error(`payload exceeds ${maxBytes} byte limit`);
    }
    return body;
  }
  const reader = new Blob([body as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`payload exceeds ${maxBytes} byte limit when unpacked`);
    }
    chunks.push(value);
  }
  const unpacked = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    unpacked.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return unpacked;
}
