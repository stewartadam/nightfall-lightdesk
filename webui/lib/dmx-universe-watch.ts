// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { dmxUniverseWatch } from "../state/appStores";
import type { DmxUniverseKey } from "../types";
import { dmxUniverseKeyId, dmxUniverseKeyOf } from "./dmx-universe-data";
import { setStoreAction } from "./nanostore-action";

/** Watched universes by key id, with how many views currently watch each. */
const watchers = new Map<string, { key: DmxUniverseKey; count: number }>();
let publishQueued = false;

/**
 * Publishes the watched universe set to `dmxUniverseWatch` once the current task's watch changes
 * settle, so a view that stops and restarts watching the same universe sends nothing.
 */
function queuePublish(): void {
  if (publishQueued) return;
  publishQueued = true;
  /** Publishes the watched keys unless they equal what the store already holds. */
  queueMicrotask(() => {
    publishQueued = false;
    const universes = Array.from(watchers.values(), (entry) => entry.key);
    const current = dmxUniverseWatch.get();
    const unchanged =
      current.length === universes.length &&
      current.every(
        (key, index) =>
          dmxUniverseKeyId(key) === dmxUniverseKeyId(universes[index]),
      );
    if (!unchanged) {
      setStoreAction(dmxUniverseWatch, "Watch DMX universes", universes);
    }
  });
}

/**
 * Asks the backend for one universe's channel values until the returned function is called.
 * Several views may watch the same universe; it stays watched until every one released it.
 */
export function watchDmxUniverse(key: DmxUniverseKey): () => void {
  const id = dmxUniverseKeyId(key);
  const entry = watchers.get(id);
  if (entry) {
    entry.count++;
  } else {
    watchers.set(id, { key: dmxUniverseKeyOf(key), count: 1 });
  }
  queuePublish();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = watchers.get(id);
    if (!current) return;
    current.count--;
    if (current.count === 0) watchers.delete(id);
    queuePublish();
  };
}
