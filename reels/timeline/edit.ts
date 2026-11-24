// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  assembleEdit,
  type CaptionCue,
  editTools,
  type ReelDefinition,
  STANDARD_OUTRO,
  type ZoomCue,
} from "../kit/shared/edit";

/**
 * The timeline reel: two Snap cues placed on the Lo-fi timeline, one from the
 * insert picker and one dragged from the clip list, then a few seeks that the
 * 3D view follows, then playback with the timeline's music. The only zoom
 * frames the insert picker; the rest stays wide so the timeline and the 3D
 * view share the frame.
 */
export const timelineReel: ReelDefinition = {
  id: "timeline",
  buildEdit(manifest) {
    const { marker, reel, focusOn, trimStart } = editTools(manifest, "begin");
    const insertAim = marker("insert-aim");
    const pickerOpen = marker("picker-open");
    const inserted = marker("inserted");
    const clipsTab = marker("clips-tab");
    const dragged = marker("dragged");
    const seek = marker("seek");
    const playStart = marker("play");
    const finish = marker("finish");

    const zooms: ZoomCue[] = [
      ...focusOn(insertAim.t + 0.9, inserted.t + 0.3, pickerOpen.rect, 1.6),
    ];

    /** A bottom caption from one recording time to another. */
    const caption = (from: number, to: number, text: string): CaptionCue => ({
      start: reel(from),
      end: reel(to),
      text,
      placement: "bottom",
    });

    const captions: CaptionCue[] = [
      caption(trimStart, insertAim.t, "This show's cues sit on a timeline"),
      caption(
        insertAim.t,
        Math.min(inserted.t + 0.5, insertAim.t + 5),
        "Insert a clip right on the beat",
      ),
      caption(
        clipsTab.t - 0.3,
        Math.min(dragged.t + 0.6, clipsTab.t + 5),
        "Or drag one in from the clip list",
      ),
      caption(
        seek.t,
        Math.min(playStart.t - 0.8, seek.t + 5),
        "The 3D view rebuilds the look wherever you seek",
      ),
      caption(
        playStart.t + 0.3,
        Math.min(finish.t, playStart.t + 5),
        "Cues play back in time with the track",
      ),
    ];

    return assembleEdit({
      intro: {
        kicker: "New in Nightfall",
        title: "Timelines",
        subtitle: "Line up cues with music",
      },
      outro: STANDARD_OUTRO,
      trimStart,
      trimEnd: finish.t,
      captions,
      zooms,
      music: { start: reel(playStart.t), from: playStart.value ?? 0 },
    });
  },
};
