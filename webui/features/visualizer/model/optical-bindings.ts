// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FixtureGeometry, OpticalChannel } from "../../../types";

/** Resolves source geometry inheritance once per fixture build, keeping nearest controls per attribute. */
export function bindEmitterOpticalChannels(
  geometry: FixtureGeometry,
): Map<string, OpticalChannel[]> {
  const channelsByGeometry = new Map<string, OpticalChannel[]>();
  for (const channel of geometry.opticalChannels ?? []) {
    const channels = channelsByGeometry.get(channel.geometry) ?? [];
    channels.push(channel);
    channelsByGeometry.set(channel.geometry, channels);
  }
  const result = new Map<string, OpticalChannel[]>();
  for (let index = 0; index < geometry.nodes.length; index++) {
    const emitter = geometry.nodes[index];
    if (emitter.geometryType !== "beam") continue;
    const inherited = new Map<string, OpticalChannel>();
    const visited = new Set<number>();
    let ancestor = index;
    while (
      ancestor >= 0 &&
      ancestor < geometry.nodes.length &&
      !visited.has(ancestor)
    ) {
      visited.add(ancestor);
      const node = geometry.nodes[ancestor];
      for (const channel of channelsByGeometry.get(node.name) ?? []) {
        if (!inherited.has(channel.attribute))
          inherited.set(channel.attribute, channel);
      }
      ancestor = node.parentIndex;
    }
    result.set(emitter.name, [...inherited.values()]);
  }
  return result;
}
