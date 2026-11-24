// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  assembleEdit,
  type CaptionCue,
  DESKTOP_OUTRO,
  editTools,
  type ReelDefinition,
  type ZoomCue,
} from "../kit/shared/edit";

/**
 * Seconds the camera holds still after a click before it pulls back out, so
 * the viewer sees what the click did.
 */
const CLICK_PADDING = 1;

/**
 * How much earlier than a click `focusOn` must arrive for the camera to have
 * settled half a second before it: `focusOn` is fully in 0.3 s before its
 * arrive time.
 */
const SETTLE_BEFORE_CLICK = 0.2;

/** Longest a caption stays up, so it doesn't linger over later actions. */
const CAPTION_SECONDS = 5;

/**
 * The MVR import reel: a mid-size rig exported from another design tool is
 * dropped on Import Rig from MVR, its summary shows the fixture types it
 * brings, and the import lands the trusses, fixtures and stage in the full 3D
 * view.
 */
export const mvrImportReel: ReelDefinition = {
  id: "mvr-import",
  buildEdit(manifest) {
    const { marker, reel, focusOn, trimStart } = editTools(manifest, "begin");
    const menuButton = marker("menu-button");
    const menu = marker("menu");
    const menuItem = marker("menu-item");
    const summary = marker("summary");
    const importPress = marker("import");
    const rig = marker("rig");
    const finish = marker("finish");

    const zooms: ZoomCue[] = [
      // One push-in on the app menu once the cursor is on the hamburger,
      // settled half a second before its click and held until a second after
      // the item click.
      ...focusOn(
        menuButton.t - SETTLE_BEFORE_CLICK,
        menuItem.t + CLICK_PADDING,
        menu.rect,
        2,
      ),
      // The Import click stays wide: on a fast machine the rig lands within a
      // second of it, before a zoom on the button could pull back out, and the
      // viewer should see the whole 3D view the moment it appears.
    ];

    const captions: CaptionCue[] = [
      {
        start: reel(menuItem.t + CLICK_PADDING + 0.6),
        end: reel(summary.t),
        text: "Drop in an MVR file from your design software",
        placement: "bottom",
      },
      {
        start: reel(summary.t),
        end: reel(Math.min(summary.t + CAPTION_SECONDS, importPress.t)),
        text: "Nightfall reads the fixture types packed inside it",
        placement: "bottom",
      },
      {
        start: reel(rig.t + 0.5),
        end: reel(Math.min(rig.t + 0.5 + CAPTION_SECONDS, finish.t)),
        text: "The fixtures land patched and hung at their positions in 3D",
        placement: "bottom",
      },
    ];

    return assembleEdit({
      intro: {
        kicker: "New in Nightfall",
        title: "MVR import",
        subtitle: "Load a rig drawn in another design tool",
      },
      outro: DESKTOP_OUTRO,
      trimStart,
      trimEnd: finish.t,
      captions,
      zooms,
    });
  },
};
