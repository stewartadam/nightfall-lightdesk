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
} from "../kit/shared/edit";

/**
 * The busking reel: a chase fired from a board button, its speed doubled and
 * put back from the speed buttons, a switch to Rainbow Cycle, and a slower
 * tempo tapped on the tempo pad that slows the rainbow down. The board and the
 * 3D view share the frame, so the reel holds the wide shot throughout and lets
 * the rig show each change as it happens.
 */
export const buskingReel: ReelDefinition = {
  id: "busking",
  buildEdit(manifest) {
    const { marker, reel, trimStart } = editTools(manifest, "begin");
    const double = marker("double");
    const tap = marker("tap");
    const swap = marker("swap");
    const finish = marker("finish");

    /** A bottom caption from one recording time to another. */
    const caption = (from: number, to: number, text: string): CaptionCue => ({
      start: reel(from),
      end: reel(to),
      text,
      placement: "bottom",
    });

    const captions: CaptionCue[] = [
      caption(
        trimStart,
        trimStart + 5,
        "Create custom button layouts on Boards to control your show",
      ),
      caption(double.t - 0.4, swap.t - 0.4, "Change timing on the fly"),
      caption(tap.t - 0.2, finish.t, "Tap a beat to adjust effect speed"),
    ];

    return assembleEdit({
      intro: {
        kicker: "New in Nightfall",
        title: "Boards",
        subtitle: "Busk shows using boards to adjust live playback",
      },
      outro: STANDARD_OUTRO,
      trimStart,
      trimEnd: finish.t,
      captions,
      zooms: [],
    });
  },
};
