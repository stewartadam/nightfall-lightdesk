// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { defineEngineControl, type EngineControl } from "../../actions";

/**
 * Defines a timeline's play/pause button.
 *
 * `toggle` must operate the playback of the timeline identified by `timelineUid`; the
 * button's click can prepare client-side playback, such as priming demo audio, that a
 * bound controller does not need.
 */
export function timelinePlaybackControl(
  timelineUid: string,
  toggle: () => void,
): EngineControl<{ toggle: () => void }> {
  return defineEngineControl({
    id: "timeline.toggle-playback",
    label: "Play/pause timeline",
    args: { timeline: timelineUid },
    handlers: () => ({ toggle }),
  });
}
