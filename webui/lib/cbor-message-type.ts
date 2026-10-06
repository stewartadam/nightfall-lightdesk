// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const CBOR_MAJOR_TEXT = 3;
const CBOR_MAJOR_MAP = 5;
const CBOR_INDEFINITE_LENGTH = 31;
const TYPE_KEY = "type";

const textDecoder = new TextDecoder();

/** One CBOR data item header: its major type, argument, and the offset after the header. */
interface CborHeader {
  major: number;
  argument: number;
  next: number;
}

/**
 * Reads the CBOR header at `offset`, or returns undefined when it is truncated or uses an
 * argument wider than 32 bits, which no message envelope header needs.
 */
function readHeader(bytes: Uint8Array, offset: number): CborHeader | undefined {
  if (offset >= bytes.length) return undefined;
  const initial = bytes[offset];
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info < 24) return { major, argument: info, next: offset + 1 };
  if (info === CBOR_INDEFINITE_LENGTH) {
    return { major, argument: -1, next: offset + 1 };
  }
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  if (width === 0 || offset + 1 + width > bytes.length) return undefined;
  let argument = 0;
  for (let index = 1; index <= width; index++) {
    argument = argument * 256 + bytes[offset + index];
  }
  return { major, argument, next: offset + 1 + width };
}

/** Reads a definite-length text string at `offset` and the offset after it. */
function readText(
  bytes: Uint8Array,
  offset: number,
): { text: string; next: number } | undefined {
  const header = readHeader(bytes, offset);
  if (!header || header.major !== CBOR_MAJOR_TEXT || header.argument < 0) {
    return undefined;
  }
  const end = header.next + header.argument;
  if (end > bytes.length) return undefined;
  return {
    text: textDecoder.decode(bytes.subarray(header.next, end)),
    next: end,
  };
}

/**
 * Returns the `type` tag of a CBOR-encoded client message without decoding its payload.
 *
 * Engine client messages are maps whose first entry is the `type` tag, so reading two
 * short text strings identifies the message. Returns undefined for any other layout, in
 * which case callers decode the full message instead.
 */
export function peekCborMessageType(bytes: Uint8Array): string | undefined {
  const map = readHeader(bytes, 0);
  if (!map || map.major !== CBOR_MAJOR_MAP || map.argument === 0) {
    return undefined;
  }
  const key = readText(bytes, map.next);
  if (key?.text !== TYPE_KEY) return undefined;
  return readText(bytes, key.next)?.text;
}
