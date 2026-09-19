// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bundled tracks installed into each sample show's own media directory.

use crate::systems::showfile_events::InitialShowfileAsset;

/// Embedded media uses the same relative layout as uploaded timeline audio.
pub(crate) const SAMPLE_AUDIO: &[InitialShowfileAsset] = &[
    InitialShowfileAsset {
        relative_path: "timeline-audio/098145c1934b4ed6b20078df6c6da180/lofi.mp3",
        bytes: include_bytes!("../../assets/sample-audio/lofi.mp3"),
    },
    InitialShowfileAsset {
        relative_path: "timeline-audio/87db6c536c244243894b725cef5e6301/rap.mp3",
        bytes: include_bytes!("../../assets/sample-audio/rap.mp3"),
    },
];
