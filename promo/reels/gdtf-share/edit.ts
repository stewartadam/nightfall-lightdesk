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
} from "../../shared/edit";

/**
 * The GDTF Share reel: the patch wizard finds no Spiider in the library,
 * searches GDTF Share for it, installs the manufacturer's file, and patches
 * eight in its wash mode. Zooms follow the search results, the install
 * button, the mode list and the quantity.
 */
export const gdtfShareReel: ReelDefinition = {
  id: "gdtf-share",
  buildEdit(manifest) {
    const { marker, reel, focusOn, trimStart } = editTools(manifest, "begin");
    const noMatch = marker("no-match");
    const results = marker("results");
    const install = marker("install");
    const installed = marker("installed");
    const mode = marker("mode");
    const quantity = marker("quantity");
    const patched = marker("patched");
    const finish = marker("finish");

    const zooms: ZoomCue[] = [
      ...focusOn(results.t - 0.2, install.t - 1.4, results.rect, 1.35),
      ...focusOn(install.t - 1.2, installed.t + 1.2, install.rect, 1.8),
      ...focusOn(mode.t - 0.6, mode.t + 0.8, mode.rect, 1.5),
      ...focusOn(quantity.t - 0.8, quantity.t + 0.8, quantity.rect, 1.8),
    ];

    const captions: CaptionCue[] = [
      {
        start: reel(trimStart),
        end: reel(noMatch.t + 0.4),
        text: "The Robin Spiider isn't in the library yet",
        placement: "bottom",
      },
      {
        start: reel(noMatch.t + 0.4),
        end: reel(install.t - 0.4),
        text: "Search GDTF Share without leaving the patch wizard",
        placement: "bottom",
      },
      {
        start: reel(install.t - 0.4),
        end: reel(mode.t - 0.6),
        text: "Install downloads the file Robe uploaded",
        placement: "bottom",
      },
      {
        start: reel(mode.t - 0.6),
        end: reel(patched.t),
        text: "Pick a mode and how many you need",
        placement: "bottom",
      },
      {
        start: reel(patched.t),
        end: reel(finish.t),
        text: "All eight are patched and addressed",
        placement: "bottom",
      },
    ];

    return assembleEdit({
      intro: {
        kicker: "New in Nightfall",
        title: "GDTF Share",
        subtitle: "Patch fixtures that aren't in your library yet",
      },
      outro: DESKTOP_OUTRO,
      trimStart,
      trimEnd: finish.t,
      captions,
      zooms,
    });
  },
};
