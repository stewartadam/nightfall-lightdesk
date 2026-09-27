// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Minimal PNG decoding for pixel assertions on Playwright screenshots.
 *
 * Screenshots are 8-bit RGB or RGBA, so only those formats are supported.
 */

import { inflateSync } from "node:zlib";
import { expect } from "./playwright-fixtures";

/** Raw pixels of a decoded PNG, row-major with `channels` bytes per pixel. */
export type DecodedPng = {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
};

/**
 * Decodes a PNG buffer into raw image metadata and pixels.
 */
export function decodePng(png: Buffer): DecodedPng {
  const signature = png.subarray(0, 8).toString("hex");
  expect(signature).toBe("89504e470d0a1a0a");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  expect(bitDepth).toBe(8);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  expect(channels).toBeGreaterThan(0);

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  const data = Buffer.alloc(height * stride);
  let inputOffset = 0;

  for (let y = 0; y < height; y++) {
    const filter = inflated[inputOffset++];
    inflated.copy(current, 0, inputOffset, inputOffset + stride);
    inputOffset += stride;

    unfilterScanline(current, previous, filter, channels);

    current.copy(data, y * stride);
    current.copy(previous);
  }

  return { width, height, channels, data };
}

/**
 * Returns the Rec. 709 luma (0-255) of the pixel at `(x, y)`.
 */
export function pixelLuma(decoded: DecodedPng, x: number, y: number): number {
  const offset = (y * decoded.width + x) * decoded.channels;
  return (
    decoded.data[offset] * 0.2126 +
    decoded.data[offset + 1] * 0.7152 +
    decoded.data[offset + 2] * 0.0722
  );
}

/**
 * Reverses PNG scanline filtering for one decoded row.
 */
function unfilterScanline(
  scanline: Buffer,
  previous: Buffer,
  filter: number,
  bytesPerPixel: number,
): void {
  for (let index = 0; index < scanline.length; index++) {
    const left = index >= bytesPerPixel ? scanline[index - bytesPerPixel] : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;

    if (filter === 1) {
      scanline[index] = (scanline[index] + left) & 0xff;
    } else if (filter === 2) {
      scanline[index] = (scanline[index] + up) & 0xff;
    } else if (filter === 3) {
      scanline[index] = (scanline[index] + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      scanline[index] = (scanline[index] + paeth(left, up, upLeft)) & 0xff;
    }
  }
}

/**
 * Computes the Paeth predictor used by PNG scanline decoding.
 */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  return upDistance <= upLeftDistance ? up : upLeft;
}
