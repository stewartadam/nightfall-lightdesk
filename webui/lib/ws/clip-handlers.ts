// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { armedLaunches, clips } from "../../state/appStores";
import type * as types from "../../types";
import { getLogger } from "../logger";
import { setStoreAction, setStoreKeyAction } from "../nanostore-action";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);

/** Registers clip snapshot and clip command echo handlers. */
export function registerClipHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("ClipDefinitions", (message) => {
    const clipMap: Record<string, [types.Clip, boolean]> = {};
    for (const { clip, is_active } of message.data) {
      clipMap[clip.identifiers.uid] = [clip, is_active];
    }
    setStoreAction(clips, "Receive ClipDefinitions", clipMap);
  });

  registry.register("ArmedLaunches", (message) => {
    const byClip: Record<number, types.ArmedLaunch> = {};
    for (const launch of message.data) {
      byClip[launch.clip_id] = launch;
    }
    setStoreAction(armedLaunches, "Receive ArmedLaunches", byClip);
  });

  registry.register("ClipCommand", (message) => {
    handleClipCommand(message.data as unknown as types.ClipCommand);
  });
}

/** Expands a backend id expression into ordered numeric ids, honoring ranges and subtraction. */
function expandIdExpr(idExpr: types.IdExpr): number[] {
  switch (idExpr.type) {
    case "Single":
      return [idExpr.data];
    case "Range": {
      const { start, end } = idExpr.data;
      if (start <= end) {
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      }
      return Array.from({ length: start - end + 1 }, (_, i) => start - i);
    }
    case "Add":
      return [
        ...expandIdExpr(idExpr.data.lhs),
        ...expandIdExpr(idExpr.data.rhs),
      ];
    case "Sub": {
      const lhs = expandIdExpr(idExpr.data.lhs);
      const toRemove = new Set(expandIdExpr(idExpr.data.rhs));
      return lhs.filter((id) => !toRemove.has(id));
    }
    case "Span":
      return expandIdExpr(idExpr.data);
  }
  return [];
}

/** Applies clip start/stop/delete commands to the local clip store. */
function handleClipCommand(command: types.ClipCommand) {
  log.trace("Handling ClipCommand:", command);

  switch (command.type) {
    case "StartClip": {
      const clipIds = new Set(expandIdExpr(command.data));
      log.trace("Starting clips from command", [...clipIds]);
      const execMap = clips.get();
      for (const [uid, [clip, _isActive]] of Object.entries(execMap)) {
        if (clipIds.has(clip.identifiers.id)) {
          setStoreKeyAction(clips, "Start Clip", uid, [clip, true]);
        }
      }
      break;
    }
    case "StopClip": {
      const clipIds = new Set(expandIdExpr(command.data));
      log.trace("Stopping clips from command", [...clipIds]);
      const execMap = clips.get();
      for (const [uid, [clip, _isActive]] of Object.entries(execMap)) {
        if (clipIds.has(clip.identifiers.id)) {
          setStoreKeyAction(clips, "Stop Clip", uid, [clip, false]);
        }
      }
      break;
    }
    case "DeleteClip": {
      const clipId = command.data as number;
      log.trace(`Deleting clip ${clipId}`);
      // Find the clip by ID and remove it from the map
      const clipMap = clips.get();
      for (const [uid, [clip]] of Object.entries(clipMap)) {
        if (clip.identifiers.id === clipId) {
          const updatedMap = { ...clipMap };
          delete updatedMap[uid];
          setStoreAction(clips, "Delete Clip", updatedMap);
          break;
        }
      }
      break;
    }
    default:
      log.warn(`Unhandled ClipCommand: ${command.type}`);
  }
}
