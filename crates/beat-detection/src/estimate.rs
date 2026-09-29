// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Conversion of Beat This model output into a scored beatgrid estimate.

use std::cmp::Ordering;
use std::path::Path;

use crate::beat_this;

/// One beat of an estimated grid, starting at the first detected downbeat.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EstimatedBeat {
    /// Beat time from the start of the audio, in seconds.
    pub time_sec: f32,
    /// Whether this beat starts a bar.
    pub is_downbeat: bool,
}

/// Beatgrid inferred from an audio file, independent of any timeline model.
#[derive(Debug, Clone, PartialEq)]
pub struct BeatgridEstimate {
    /// Estimated tempo in beats per minute.
    pub bpm: f32,
    /// Estimated number of beats in each bar.
    pub beats_per_bar: u8,
    /// Beats from the first downbeat onwards.
    pub beats: Vec<EstimatedBeat>,
    /// Overall confidence in the grid, from 0 to 1.
    pub confidence: f32,
}

/// Analyze an audio file with the downloaded model and score the resulting beatgrid.
///
/// `fallback_beats_per_bar` is used when the model's downbeats do not imply a bar length.
/// Fails when the model is missing or unverified, the audio cannot be decoded, or too few
/// beats are detected to derive a tempo.
pub fn estimate(audio_path: &Path, fallback_beats_per_bar: u8) -> Result<BeatgridEstimate, String> {
    let model_paths = beat_this::BeatThisModelPaths::resolve()?;
    let analysis = beat_this::analyze_path(audio_path, &model_paths)?;

    if analysis.beats.len() < 2 {
        return Err("Could not detect enough beats in audio".to_string());
    }

    let first_downbeat_index =
        beat_this::first_downbeat_index(&analysis.beats, &analysis.downbeats).unwrap_or(0);
    let beat_times_sec = &analysis.beats[first_downbeat_index..];
    if beat_times_sec.len() < 2 {
        return Err("Could not detect enough beats after first downbeat".to_string());
    }

    let beat_intervals_sec: Vec<f32> = beat_times_sec
        .windows(2)
        .filter_map(|window| {
            let delta_sec = window[1] - window[0];
            if delta_sec <= 0.0 {
                None
            } else {
                Some(delta_sec)
            }
        })
        .collect();
    if beat_intervals_sec.is_empty() {
        return Err("Detected beats have invalid timing intervals".to_string());
    }

    let bpm = beat_this::calculate_bpm(beat_times_sec)
        .unwrap_or_else(|| (60.0 / median(&beat_intervals_sec)).clamp(1.0, 300.0));

    let interval_consistency = compute_interval_consistency(&beat_intervals_sec);
    let beat_density = (beat_times_sec.len() as f32 / 128.0).min(1.0);
    let model_peak_confidence =
        compute_model_peak_confidence(&analysis.beat_logits, &analysis.downbeat_logits);
    let downbeat_confidence = if analysis.downbeats.is_empty() {
        0.0
    } else {
        1.0
    };
    let confidence = (interval_consistency * 0.55
        + model_peak_confidence * 0.25
        + downbeat_confidence * 0.1
        + beat_density * 0.1)
        .clamp(0.0, 1.0);

    let beats_per_bar = beat_this::infer_beats_per_bar(&analysis.beats, &analysis.downbeats)
        .unwrap_or(fallback_beats_per_bar)
        .max(1);
    let beats = beat_times_sec
        .iter()
        .copied()
        .enumerate()
        .map(|(index, time_sec)| EstimatedBeat {
            time_sec,
            is_downbeat: beat_this::is_model_downbeat(time_sec, &analysis.downbeats)
                || index % usize::from(beats_per_bar) == 0,
        })
        .collect();

    Ok(BeatgridEstimate {
        bpm,
        beats_per_bar,
        beats,
        confidence,
    })
}

/// Return the median of a non-empty slice, averaging the two middle values for even lengths.
fn median(values: &[f32]) -> f32 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|lhs, rhs| lhs.partial_cmp(rhs).unwrap_or(Ordering::Equal));
    let middle = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) * 0.5
    } else {
        sorted[middle]
    }
}

/// Score how regular beat intervals are: 1 for identical intervals, falling with the coefficient of variation.
fn compute_interval_consistency(intervals: &[f32]) -> f32 {
    if intervals.is_empty() {
        return 0.0;
    }

    let mean = intervals.iter().copied().sum::<f32>() / intervals.len() as f32;
    if mean <= f32::EPSILON {
        return 0.0;
    }

    let variance = intervals
        .iter()
        .copied()
        .map(|value| {
            let diff = value - mean;
            diff * diff
        })
        .sum::<f32>()
        / intervals.len() as f32;
    let std_dev = variance.sqrt();
    let coeff_variation = (std_dev / mean).clamp(0.0, 1.0);
    (1.0 - coeff_variation).clamp(0.0, 1.0)
}

/// Blend beat and downbeat logit confidence, weighting beats three times as heavily as downbeats.
fn compute_model_peak_confidence(beat_logits: &[f32], downbeat_logits: &[f32]) -> f32 {
    let beat_confidence = positive_logit_confidence(beat_logits);
    let downbeat_confidence = positive_logit_confidence(downbeat_logits);
    (beat_confidence * 0.75 + downbeat_confidence * 0.25).clamp(0.0, 1.0)
}

/// Map the mean of positive finite logits through a sigmoid, or 0 when there are none.
fn positive_logit_confidence(logits: &[f32]) -> f32 {
    let positive_logits: Vec<f32> = logits
        .iter()
        .copied()
        .filter(|logit| logit.is_finite() && *logit > 0.0)
        .collect();
    if positive_logits.is_empty() {
        return 0.0;
    }

    let mean_logit = positive_logits.iter().sum::<f32>() / positive_logits.len() as f32;
    (1.0 / (1.0 + (-mean_logit).exp())).clamp(0.0, 1.0)
}
