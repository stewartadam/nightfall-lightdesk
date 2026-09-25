// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  UnsignedByteType,
} from "three/webgpu";
import { GoboStackTable } from "./gobo-stack-table";

const TILE_SIZE = 256;
const PADDING = 2;

/** Stable slot reference; shader coordinates derive from the current atlas size. */
export interface GoboAtlasSlot {
  index: number;
  status: "loading" | "ready" | "failed";
}

/** Shares gobo masks across emitters and decodes each source image once per scene. */
export class GoboAtlas {
  readonly stacks = new GoboStackTable();
  readonly texture: DataTexture;
  private side = 1024;
  private pixels = new Uint8Array(this.side * this.side);
  private readonly slots = new Map<string, GoboAtlasSlot>();
  private readonly abort = new AbortController();
  private disposed = false;

  /** Reserves the first tile as an open aperture; remaining tiles contain imported masks. */
  constructor(private readonly maxSide = 4096) {
    this.texture = new DataTexture(
      this.pixels,
      this.side,
      this.side,
      RedFormat,
      UnsignedByteType,
    );
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.flipY = false;
    this.writeTile(0, new Uint8Array(TILE_SIZE * TILE_SIZE).fill(255));
  }

  /** Gives the current row stride so existing slot indices remain valid after growth. */
  get tilesPerRow(): number {
    return this.side / TILE_SIZE;
  }

  /** Starts one setup-time image request and returns a shared stable handle immediately. */
  load(url: string): GoboAtlasSlot {
    const existing = this.slots.get(url);
    if (existing) return existing;
    const slot: GoboAtlasSlot = {
      index: this.slots.size + 1,
      status: "loading",
    };
    this.slots.set(url, slot);
    if (this.disposed || !this.reserve(slot.index)) {
      slot.status = "failed";
      return slot;
    }
    void this.decode(url, slot);
    return slot;
  }

  /** Cancels outstanding loads and releases the shared GPU texture. */
  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.texture.dispose();
    this.stacks.dispose();
    this.slots.clear();
  }

  /** Expands by whole tiles, preserving stable slot order and filtering isolation. */
  private reserve(index: number): boolean {
    if (index < this.tilesPerRow ** 2) return true;
    const nextSide = this.side * 2;
    if (nextSide > this.maxSide) return false;
    const previous = this.pixels;
    const oldSide = this.side;
    const oldStride = this.tilesPerRow;
    this.side = nextSide;
    this.pixels = new Uint8Array(nextSide * nextSide);
    for (let tile = 0; tile < oldStride ** 2; tile++) {
      const oldX = (tile % oldStride) * TILE_SIZE;
      const oldY = Math.floor(tile / oldStride) * TILE_SIZE;
      const newX = (tile % this.tilesPerRow) * TILE_SIZE;
      const newY = Math.floor(tile / this.tilesPerRow) * TILE_SIZE;
      for (let row = 0; row < TILE_SIZE; row++) {
        const start = (oldY + row) * oldSide + oldX;
        this.pixels.set(
          previous.subarray(start, start + TILE_SIZE),
          (newY + row) * nextSide + newX,
        );
      }
    }
    this.texture.image = {
      data: this.pixels,
      width: this.side,
      height: this.side,
    };
    this.texture.needsUpdate = true;
    return true;
  }

  /** Decodes off the playback path; failures remain explicit instead of inventing a gobo. */
  private async decode(url: string, slot: GoboAtlasSlot): Promise<void> {
    let bitmap: ImageBitmap | undefined;
    try {
      const response = await fetch(url, { signal: this.abort.signal });
      if (!response.ok) throw new Error(`Gobo response ${response.status}`);
      bitmap = await createImageBitmap(await response.blob());
      if (this.disposed) {
        slot.status = "failed";
        return;
      }
      const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
      const context = canvas.getContext("2d")!;
      context.fillStyle = "black";
      context.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
      context.drawImage(
        bitmap,
        PADDING,
        PADDING,
        TILE_SIZE - PADDING * 2,
        TILE_SIZE - PADDING * 2,
      );
      const rgba = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
      const mask = new Uint8Array(TILE_SIZE * TILE_SIZE);
      for (let i = 0; i < mask.length; i++) {
        mask[i] = Math.round(
          (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3,
        );
      }
      this.writeTile(slot.index, mask);
      slot.status = "ready";
    } catch {
      slot.status = "failed";
    } finally {
      bitmap?.close();
    }
  }

  /** Copies a decoded mask into its tile and requests one upload on the next render. */
  private writeTile(index: number, mask: Uint8Array): void {
    const x = (index % this.tilesPerRow) * TILE_SIZE;
    const y = Math.floor(index / this.tilesPerRow) * TILE_SIZE;
    for (let row = 0; row < TILE_SIZE; row++)
      this.pixels.set(
        mask.subarray(row * TILE_SIZE, (row + 1) * TILE_SIZE),
        (y + row) * this.side + x,
      );
    this.texture.needsUpdate = true;
  }
}
