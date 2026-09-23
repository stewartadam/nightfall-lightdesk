// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Group, Mesh } from "three/webgpu";
import { cloneFixtureMesh, disposeFixtureMesh } from "./mesh-ownership";

interface Entry {
  promise: Promise<Group>;
  template?: Group;
  bytes: number;
  waiters: number;
}

/** Measure retained vertex/index/morph backing buffers once, including interleaved attributes. Excludes JS and GPU overhead. */
function geometryBytes(root: Group): number {
  const buffers = new Set<ArrayBufferLike>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const attributes = [
      ...Object.values(geometry.attributes),
      ...Object.values(geometry.morphAttributes).flat(),
      ...(geometry.index ? [geometry.index] : []),
    ];
    for (const attribute of attributes) {
      const array =
        "data" in attribute ? attribute.data.array : attribute.array;
      buffers.add(array.buffer);
    }
  });
  let bytes = 0;
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}

/** Coalesce model loads and bound idle decoded templates while live instances retain their own geometry references. */
export class FixtureMeshCache {
  private readonly entries = new Map<string, Entry>();

  /** Configure decoded-template retention; zero disables retention without duplicating simultaneous loads. */
  constructor(
    private readonly maxEntries = 64,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0
    ) {
      throw new Error("Mesh cache limits must be nonnegative safe integers");
    }
  }

  /** Return an independent instance; one failure rejects all current waiters and a later call may retry. */
  async load(key: string, factory: () => Promise<Group>): Promise<Group> {
    let entry = this.entries.get(key);
    if (!entry) {
      // Defer factory execution until the entry is registered, including synchronous failures.
      const created: Entry = {
        promise: Promise.resolve().then(factory),
        bytes: 0,
        waiters: 0,
      };
      created.promise = created.promise.then((template) => {
        created.template = template;
        created.bytes = geometryBytes(template);
        return template;
      });
      entry = created;
    } else {
      this.entries.delete(key);
    }
    this.entries.set(key, entry);
    entry.waiters++;
    try {
      return cloneFixtureMesh(await entry.promise);
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    } finally {
      entry.waiters--;
      this.trim();
    }
  }

  /** Report template retention separately from pending work and live instance memory. */
  get stats(): { templates: number; bytes: number; pending: number } {
    let templates = 0;
    let bytes = 0;
    let pending = 0;
    for (const entry of this.entries.values()) {
      if (entry.template) {
        templates++;
        bytes += entry.bytes;
      } else {
        pending++;
      }
    }
    return { templates, bytes, pending };
  }

  /** Evict the least recently requested ready templates after all their current waiters have cloned them. */
  private trim(): void {
    let { templates, bytes } = this.stats;
    for (const [key, entry] of this.entries) {
      if (templates <= this.maxEntries && bytes <= this.maxBytes) break;
      if (!entry.template || entry.waiters > 0) continue;
      this.entries.delete(key);
      templates--;
      bytes -= entry.bytes;
      disposeFixtureMesh(entry.template);
    }
  }
}

/** Shared budget across archive revisions and bundled primitive assets in this renderer context. */
export const fixtureMeshCache = new FixtureMeshCache();
