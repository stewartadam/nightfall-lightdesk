// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Connects the Beat This model backend to timeline beatgrid detection.

use std::path::Path;

use nightfall_timeline::prelude::{BeatgridDetector, DetectedBeat, DetectedBeatgrid};

/// Detector that analyzes audio with the downloaded Beat This model.
pub(crate) const DETECTOR: BeatgridDetector = BeatgridDetector {
    model_installed,
    detect,
};

/// Report whether model weights exist in application data, without verifying their checksum.
fn model_installed() -> bool {
    nightfall_beatgrid::model::model_path().is_ok_and(|path| path.is_file())
}

/// Estimate a beatgrid for an audio file and map it into the timeline's detection result.
fn detect(audio_path: &Path, fallback_beats_per_bar: u8) -> Result<DetectedBeatgrid, String> {
    let estimate = nightfall_beatgrid::estimate(audio_path, fallback_beats_per_bar)?;
    Ok(DetectedBeatgrid {
        bpm: estimate.bpm,
        beats_per_bar: estimate.beats_per_bar,
        beats: estimate
            .beats
            .into_iter()
            .map(|beat| DetectedBeat {
                time_sec: beat.time_sec,
                is_downbeat: beat.is_downbeat,
            })
            .collect(),
        confidence: estimate.confidence,
    })
}
