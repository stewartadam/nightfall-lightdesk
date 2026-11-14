// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createMemo, untrack } from "solid-js";
import { v4 as uuidv4 } from "uuid";
import { commandClient } from "../../../lib/engine-commands";
import { getLogger } from "../../../lib/logger";
import {
  createUnconfirmedPatches,
  type UnconfirmedPatch,
} from "../../../lib/unconfirmed-edits";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { timelines } from "../../../state/appStores";
import type * as types from "../../../types";

const log = getLogger(import.meta.url);

/** Options for one granular timeline edit sent from the timeline panel. */
export interface TimelineEditOptions {
  /** Undo group shared with other commands, such as the inserts of one paste. */
  undoId?: string;
}

/** Granular timeline edits with their unconfirmed patches, for one timeline panel. */
export interface TimelineEdits {
  /**
   * The timeline as the engine stores it, with this panel's unconfirmed edits laid over it,
   * or undefined while the timeline is unknown.
   */
  timeline: Accessor<types.Timeline | undefined>;
  /**
   * Sends granular edits as one undo step and shows `patch` until they are confirmed. Each edit
   * names only what it changes, so it can never revert a change made elsewhere. Does nothing
   * when the timeline is unknown or `edits` is empty.
   */
  edit(
    edits: types.TimelineEdit[],
    patch: UnconfirmedPatch<types.Timeline>,
    options?: TimelineEditOptions,
  ): void;
}

/**
 * Creates the edit channel for one timeline panel: the engine's timeline with unconfirmed
 * patches laid over it, and a way to send granular `EditTimeline` commands.
 */
export function createTimelineEdits(timelineUid: string): TimelineEdits {
  const $timelines = useShallowStore(timelines);
  const patches = createUnconfirmedPatches<types.Timeline>();

  /** The engine's copy of this panel's timeline. */
  const storeTimeline = createMemo(() => $timelines()?.[timelineUid]);

  /** The engine's timeline with this panel's unconfirmed patches applied. */
  const timeline = createMemo(() => {
    const stored = storeTimeline();
    return stored ? patches.apply(stored) : undefined;
  });

  /** Sends edits as one undo step, laying `patch` over the timeline until they settle. */
  const edit: TimelineEdits["edit"] = (edits, patch, options = {}) => {
    const stored = untrack(storeTimeline);
    if (!stored || edits.length === 0) return;
    const timelineId = stored.identifiers.id;
    // Several commands form one undo step only when they share an undo group.
    const undoId = options.undoId ?? (edits.length > 1 ? uuidv4() : undefined);
    log.debug("Sending timeline edits", { timelineId, edits });
    // The patch stays until every command settles, so a failed one doesn't drop it while the
    // others are still unconfirmed.
    patches.add(patch, () =>
      Promise.allSettled(
        edits.map((timelineEdit) =>
          commandClient.invoke(
            "TimelineCommand",
            {
              type: "EditTimeline",
              data: { timeline_id: timelineId, edit: timelineEdit },
            } satisfies types.TimelineCommand,
            { undoId },
          ),
        ),
      ),
    );
  };

  return { timeline, edit };
}
