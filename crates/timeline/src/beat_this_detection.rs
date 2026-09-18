// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Beat This model inference for beatgrid detection.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use rodio::{Decoder, Source};
use rten::{Model as RtenGraph, NodeId, Value as RtenValue};
use rten_tensor::prelude::*;
use rustfft::{FftPlanner, num_complex::Complex};

const TARGET_SAMPLE_RATE: u32 = 22_050;
const MODEL_FPS: f32 = 50.0;
const N_FFT: usize = 1024;
const HOP_LENGTH: usize = 441;
const N_MELS: usize = 128;
const F_MIN: f64 = 30.0;
const F_MAX: f64 = 11_000.0;
const LOG_MULTIPLIER: f32 = 1000.0;
const CHUNK_SIZE: usize = 1500;
const BORDER_SIZE: usize = 6;
const STRIDE: usize = CHUNK_SIZE - 2 * BORDER_SIZE;
const BUNDLED_MODEL_PATH: &str = "webui/assets/models/beat-this/beat_this.onnx";

/// Host-resolved bundle location retained across timeline worker requests.
#[derive(bevy_ecs::prelude::Resource, Debug, Clone, Default)]
pub struct BeatThisResourceDirectory(
    /// Desktop resource directory, or no override for standalone development builds.
    pub Option<PathBuf>,
);

/// Paths to the Beat This beat/downbeat model files.
#[derive(Debug, Clone)]
pub struct BeatThisModelPaths {
    /// Beat/downbeat model path.
    pub beat_model: PathBuf,
}

/// Beat This analysis result before conversion into timeline markers.
#[derive(Debug, Clone)]
pub struct BeatThisAnalysis {
    /// Beat timestamps in seconds.
    pub beats: Vec<f32>,
    /// Downbeat timestamps in seconds, snapped to the nearest detected beat.
    pub downbeats: Vec<f32>,
    /// Raw beat logits from the model.
    pub beat_logits: Vec<f32>,
    /// Raw downbeat logits from the model.
    pub downbeat_logits: Vec<f32>,
}

/// Input tensor passed to the beat-this downbeat model.
#[derive(Debug, Clone)]
struct Tensor {
    shape: Vec<usize>,
    data: Vec<f32>,
}

/// Loaded RTen beat detection model and its inference helpers.
struct RtenModel {
    model: RtenGraph,
    input_map: HashMap<String, NodeId>,
    output_names: Vec<(NodeId, String)>,
    output_ids: Vec<NodeId>,
}

impl BeatThisModelPaths {
    /// Resolve the model inside the host's bundle, or standalone development locations.
    pub fn resolve(resource_dir: Option<&Path>) -> Result<Self, String> {
        let candidates = bundled_model_candidates(resource_dir);
        let Some(beat_model) = candidates.iter().find(|candidate| candidate.is_file()) else {
            return Err(missing_model_message(&candidates));
        };

        Ok(Self {
            beat_model: beat_model.clone(),
        })
    }
}

/// Run Beat This inference for an audio file.
pub fn analyze_path(
    audio_path: &Path,
    model_paths: &BeatThisModelPaths,
) -> Result<BeatThisAnalysis, String> {
    let (samples, sample_rate) = decode_audio_file(audio_path)?;
    let samples = resample_to_target_sample_rate(&samples, sample_rate);

    let mut beat_model = RtenModel::load(&model_paths.beat_model)
        .map_err(|error| format!("Failed to load Beat This beat model: {}", error))?;

    let mel = extract_mel_spectrogram(&samples)?;
    let (beat_logits, downbeat_logits) = predict_logits(&mut beat_model, &mel)?;
    let (beats, downbeats) = decode_peaks(&beat_logits, &downbeat_logits)?;

    Ok(BeatThisAnalysis {
        beats,
        downbeats,
        beat_logits,
        downbeat_logits,
    })
}

/// Calculate BPM from beat timestamps using median inter-beat interval.
pub fn calculate_bpm(beats: &[f32]) -> Option<f32> {
    if beats.len() < 2 {
        return None;
    }

    let mut intervals: Vec<f32> = beats
        .windows(2)
        .map(|window| window[1] - window[0])
        .filter(|interval| *interval > 0.1 && *interval < 3.0)
        .collect();
    if intervals.is_empty() {
        return None;
    }

    intervals.sort_by(|lhs, rhs| lhs.total_cmp(rhs));
    let middle = intervals.len() / 2;
    let median = if intervals.len().is_multiple_of(2) {
        (intervals[middle - 1] + intervals[middle]) * 0.5
    } else {
        intervals[middle]
    };

    Some((60.0 / median).clamp(1.0, 300.0))
}

/// Infer beats per bar from distances between model downbeats.
pub fn infer_beats_per_bar(beats: &[f32], downbeats: &[f32]) -> Option<u8> {
    if beats.is_empty() || downbeats.len() < 2 {
        return None;
    }

    let downbeat_indices: Vec<usize> = downbeats
        .iter()
        .filter_map(|downbeat| nearest_beat_index(beats, *downbeat, 0.03))
        .collect();
    let mut spans: HashMap<usize, usize> = HashMap::new();
    for window in downbeat_indices.windows(2) {
        let span = window[1].saturating_sub(window[0]);
        if (2..=12).contains(&span) {
            *spans.entry(span).or_insert(0) += 1;
        }
    }

    spans
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .and_then(|(span, _)| u8::try_from(span).ok())
}

/// Return the beat index nearest to the first model downbeat.
pub fn first_downbeat_index(beats: &[f32], downbeats: &[f32]) -> Option<usize> {
    downbeats
        .iter()
        .filter_map(|downbeat| nearest_beat_index(beats, *downbeat, 0.03))
        .min()
}

/// Return whether a beat timestamp is close to a model downbeat.
pub fn is_model_downbeat(beat_time: f32, downbeats: &[f32]) -> bool {
    downbeats
        .iter()
        .any(|downbeat| (beat_time - *downbeat).abs() <= 0.03)
}

impl RtenModel {
    fn load(path: &Path) -> Result<Self, String> {
        let model = RtenGraph::load_file(path).map_err(|error| error.to_string())?;
        let input_map = model
            .input_ids()
            .iter()
            .filter_map(|&id| {
                let info = model.node_info(id)?;
                let name = info.name()?;
                Some((name.to_string(), id))
            })
            .collect();
        let output_names = model
            .output_ids()
            .iter()
            .filter_map(|&id| {
                let info = model.node_info(id)?;
                let name = info.name()?;
                Some((id, name.to_string()))
            })
            .collect();
        let output_ids = model.output_ids().to_vec();

        Ok(Self {
            model,
            input_map,
            output_names,
            output_ids,
        })
    }

    fn run(&mut self, inputs: &[(&str, &Tensor)]) -> Result<HashMap<String, Tensor>, String> {
        let rten_inputs: Vec<(NodeId, RtenValue)> = inputs
            .iter()
            .map(|(name, tensor)| {
                let node_id = self
                    .input_map
                    .get(*name)
                    .ok_or_else(|| format!("RTen model has no input named '{}'", name))?;
                let value = RtenValue::from_shape(tensor.shape.as_slice(), tensor.data.clone())
                    .map_err(|error| {
                        format!("Failed to create RTen input tensor '{}': {}", name, error)
                    })?;
                Ok((*node_id, value))
            })
            .collect::<Result<Vec<_>, String>>()?;

        let input_views: Vec<_> = rten_inputs
            .iter()
            .map(|(id, value)| (*id, value.into()))
            .collect();
        let outputs = self
            .model
            .run(input_views, &self.output_ids, None)
            .map_err(|error| error.to_string())?;

        let mut tensors = HashMap::new();
        for (&id, value) in self.output_ids.iter().zip(outputs) {
            let name = self
                .output_names
                .iter()
                .find(|(node_id, _)| *node_id == id)
                .map(|(_, name)| name.clone())
                .unwrap_or_else(|| format!("output_{:?}", id));
            let tensor = value
                .into_tensor::<f32>()
                .ok_or_else(|| format!("RTen output '{}' is not an f32 tensor", name))?;
            tensors.insert(
                name,
                Tensor {
                    shape: tensor.shape().to_vec(),
                    data: tensor.to_vec(),
                },
            );
        }

        Ok(tensors)
    }

    fn run_first_available(
        &mut self,
        input_names: &[&str],
        tensor: &Tensor,
    ) -> Result<HashMap<String, Tensor>, String> {
        let Some(name) = input_names
            .iter()
            .copied()
            .find(|name| self.input_map.contains_key(*name))
        else {
            return Err(format!(
                "RTen model has none of the expected inputs: {}",
                input_names.join(", ")
            ));
        };

        self.run(&[(name, tensor)])
    }
}

fn decode_audio_file(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let file = File::open(path)
        .map_err(|error| format!("Failed to open audio file '{}': {}", path.display(), error))?;
    let decoder = Decoder::new(BufReader::new(file)).map_err(|error| {
        format!(
            "Failed to decode audio file '{}': {}",
            path.display(),
            error
        )
    })?;
    let sample_rate = decoder.sample_rate().get();
    let channels = usize::from(decoder.channels().get()).max(1);
    let interleaved_samples: Vec<f32> = decoder.collect();

    if interleaved_samples.is_empty() {
        return Err("Decoded audio stream is empty".to_string());
    }

    let mono = if channels == 1 {
        interleaved_samples
    } else {
        interleaved_samples
            .chunks(channels)
            .map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32)
            .collect()
    };

    Ok((mono, sample_rate))
}

fn resample_to_target_sample_rate(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if sample_rate == TARGET_SAMPLE_RATE || samples.is_empty() {
        return samples.to_vec();
    }

    let target_len = ((samples.len() as f64 * f64::from(TARGET_SAMPLE_RATE))
        / f64::from(sample_rate))
    .round()
    .max(1.0) as usize;
    let step = f64::from(sample_rate) / f64::from(TARGET_SAMPLE_RATE);
    let mut resampled = Vec::with_capacity(target_len);

    for target_index in 0..target_len {
        let source_position = target_index as f64 * step;
        let source_index = source_position.floor() as usize;
        let next_index = (source_index + 1).min(samples.len() - 1);
        let fraction = (source_position - source_index as f64) as f32;
        let current = samples[source_index.min(samples.len() - 1)];
        let next = samples[next_index];
        resampled.push(current + (next - current) * fraction);
    }

    resampled
}

fn create_hann_window() -> [f32; N_FFT] {
    std::array::from_fn(|index| {
        0.5 * (1.0 - (2.0 * std::f32::consts::PI * index as f32 / N_FFT as f32).cos())
    })
}

fn reflect_pad(samples: &[f32], pad_size: usize) -> Vec<f32> {
    let padded_len = samples.len() + 2 * pad_size;
    let mut padded = Vec::with_capacity(padded_len);
    for padded_index in 0..padded_len {
        let source_index = reflect_index(padded_index as isize - pad_size as isize, samples.len());
        padded.push(samples[source_index]);
    }
    padded
}

fn reflect_index(mut index: isize, len: usize) -> usize {
    if len <= 1 {
        return 0;
    }

    let len = len as isize;
    while index < 0 || index >= len {
        if index < 0 {
            index = -index;
        }
        if index >= len {
            index = 2 * len - 2 - index;
        }
    }

    index as usize
}

fn create_mel_filterbank() -> [[f32; N_MELS]; N_FFT / 2 + 1] {
    let mel_min = hz_to_mel(F_MIN);
    let mel_max = hz_to_mel(F_MAX);
    let mel_points: [f64; N_MELS + 2] = std::array::from_fn(|index| {
        mel_min + (mel_max - mel_min) * index as f64 / (N_MELS + 1) as f64
    });
    let hz_points: [f64; N_MELS + 2] = mel_points.map(mel_to_hz);

    std::array::from_fn(|fft_bin| {
        let hz = fft_bin as f64 * f64::from(TARGET_SAMPLE_RATE) / N_FFT as f64;
        std::array::from_fn(|mel_bin| {
            let hz_left = hz_points[mel_bin];
            let hz_center = hz_points[mel_bin + 1];
            let hz_right = hz_points[mel_bin + 2];
            let left_slope = if hz_center == hz_left {
                0.0
            } else {
                (hz - hz_left) / (hz_center - hz_left)
            };
            let right_slope = if hz_right == hz_center {
                0.0
            } else {
                (hz_right - hz) / (hz_right - hz_center)
            };
            left_slope.min(right_slope).max(0.0) as f32
        })
    })
}

fn hz_to_mel(hz: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let mut mel = hz / f_sp;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = 6.4_f64.ln() / 27.0;

    if hz >= min_log_hz {
        mel = min_log_mel + (hz / min_log_hz).ln() / logstep;
    }

    mel
}

fn mel_to_hz(mel: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let mut hz = f_sp * mel;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = 6.4_f64.ln() / 27.0;

    if mel >= min_log_mel {
        hz = min_log_hz * (logstep * (mel - min_log_mel)).exp();
    }

    hz
}

fn extract_mel_spectrogram(samples: &[f32]) -> Result<Tensor, String> {
    if samples.is_empty() {
        return Err("Cannot extract Beat This mel spectrogram from empty audio".to_string());
    }

    let filterbank = create_mel_filterbank();
    let window = create_hann_window();
    let padded = reflect_pad(samples, N_FFT / 2);
    let frame_count = padded.len().saturating_sub(N_FFT) / HOP_LENGTH + 1;
    if frame_count == 0 {
        return Err("Audio is too short for Beat This mel spectrogram extraction".to_string());
    }

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let normalization = (N_FFT as f32).sqrt();
    let mut spectrum = vec![Complex::new(0.0, 0.0); N_FFT];
    let mut data = vec![0.0; frame_count * N_MELS];

    for frame_index in 0..frame_count {
        let frame_start = frame_index * HOP_LENGTH;
        for sample_index in 0..N_FFT {
            spectrum[sample_index] = Complex::new(
                padded[frame_start + sample_index] * window[sample_index],
                0.0,
            );
        }
        fft.process(&mut spectrum);

        let mut magnitudes = [0.0_f32; N_FFT / 2 + 1];
        for bin in 0..=N_FFT / 2 {
            magnitudes[bin] = spectrum[bin].norm() / normalization;
        }

        for mel_bin in 0..N_MELS {
            let mut mel_energy = 0.0_f32;
            for fft_bin in 0..=N_FFT / 2 {
                mel_energy += magnitudes[fft_bin] * filterbank[fft_bin][mel_bin];
            }
            data[frame_index * N_MELS + mel_bin] =
                (1.0 + LOG_MULTIPLIER * mel_energy.max(0.0)).ln();
        }
    }

    Ok(Tensor {
        shape: vec![1, frame_count, N_MELS],
        data,
    })
}

fn predict_logits(model: &mut RtenModel, mel: &Tensor) -> Result<(Vec<f32>, Vec<f32>), String> {
    if mel.shape.len() != 3 || mel.shape[0] != 1 || mel.shape[2] != 128 {
        return Err(format!(
            "Expected mel shape [1, T, 128], got {:?}",
            mel.shape
        ));
    }

    let full_time = mel.shape[1];
    let starts = generate_chunk_starts(full_time);
    let mut beat_logits = vec![-1000.0; full_time];
    let mut downbeat_logits = vec![-1000.0; full_time];

    for &start in starts.iter().rev() {
        let chunk = extract_chunk(mel, start);
        let chunk_time = chunk.shape[1];
        if chunk_time <= BORDER_SIZE * 2 {
            continue;
        }

        let mut outputs =
            model.run_first_available(&["input_spectrogram", "spectrogram"], &chunk)?;
        let beat = extract_output(&mut outputs, "beat", "beat_logits")?;
        let downbeat = extract_output(&mut outputs, "downbeat", "downbeat_logits")?;
        if beat.data.len() < chunk_time || downbeat.data.len() < chunk_time {
            return Err(format!(
                "Beat This model returned too few frames: beat={} downbeat={} expected={}",
                beat.data.len(),
                downbeat.data.len(),
                chunk_time
            ));
        }

        let valid_beat = &beat.data[BORDER_SIZE..chunk_time - BORDER_SIZE];
        let valid_downbeat = &downbeat.data[BORDER_SIZE..chunk_time - BORDER_SIZE];
        let write_start = (start + BORDER_SIZE as i32).max(0) as usize;

        for (index, (&beat, &downbeat)) in valid_beat.iter().zip(valid_downbeat).enumerate() {
            let target_index = write_start + index;
            if target_index < full_time {
                beat_logits[target_index] = beat;
                downbeat_logits[target_index] = downbeat;
            }
        }
    }

    Ok((beat_logits, downbeat_logits))
}

fn extract_output(
    outputs: &mut HashMap<String, Tensor>,
    primary: &str,
    fallback: &str,
) -> Result<Tensor, String> {
    if let Some(tensor) = outputs.remove(primary) {
        return Ok(tensor);
    }
    if let Some(tensor) = outputs.remove(fallback) {
        return Ok(tensor);
    }
    Err(format!(
        "Beat This model did not return '{}' or '{}' outputs",
        primary, fallback
    ))
}

fn generate_chunk_starts(full_time: usize) -> Vec<i32> {
    let mut starts = Vec::new();
    let mut position = -(BORDER_SIZE as i32);
    let limit = full_time as i32 - BORDER_SIZE as i32;

    while position < limit {
        starts.push(position);
        position += STRIDE as i32;
    }

    if full_time > STRIDE
        && let Some(last) = starts.last_mut()
    {
        *last = full_time as i32 - (CHUNK_SIZE as i32 - BORDER_SIZE as i32);
    }

    starts
}

fn extract_chunk(mel: &Tensor, start: i32) -> Tensor {
    let full_time = mel.shape[1];
    let n_mels = mel.shape[2];
    let actual_start = start.max(0) as usize;
    let actual_end = ((start + CHUNK_SIZE as i32) as usize).min(full_time);
    let pad_left = (-start).max(0) as usize;
    let n_frames = actual_end.saturating_sub(actual_start);
    let pad_right =
        0.max((start + CHUNK_SIZE as i32 - full_time as i32).min(BORDER_SIZE as i32)) as usize;

    let chunk_time = pad_left + n_frames + pad_right;
    let mut data = vec![0.0; chunk_time * n_mels];

    for frame_index in actual_start..actual_end {
        let src_offset = frame_index * n_mels;
        let dst_frame = pad_left + (frame_index - actual_start);
        let dst_offset = dst_frame * n_mels;
        data[dst_offset..dst_offset + n_mels]
            .copy_from_slice(&mel.data[src_offset..src_offset + n_mels]);
    }

    Tensor {
        shape: vec![1, chunk_time, n_mels],
        data,
    }
}

fn decode_peaks(
    beat_logits: &[f32],
    downbeat_logits: &[f32],
) -> Result<(Vec<f32>, Vec<f32>), String> {
    if beat_logits.len() != downbeat_logits.len() {
        return Err(format!(
            "Beat/downbeat logits length mismatch: {} != {}",
            beat_logits.len(),
            downbeat_logits.len()
        ));
    }

    let beats: Vec<f32> = find_peaks(beat_logits)
        .into_iter()
        .map(|frame| frame as f32 / MODEL_FPS)
        .collect();
    let mut downbeats: Vec<f32> = find_peaks(downbeat_logits)
        .into_iter()
        .map(|frame| frame as f32 / MODEL_FPS)
        .collect();

    snap_downbeats_to_beats(&beats, &mut downbeats);
    Ok((beats, downbeats))
}

fn find_peaks(logits: &[f32]) -> Vec<usize> {
    let mut peaks = Vec::new();
    for index in 0..logits.len() {
        if logits[index] <= 0.0 {
            continue;
        }

        let start = index.saturating_sub(3);
        let end = (index + 4).min(logits.len());
        if (start..end).all(|candidate| logits[candidate] <= logits[index]) {
            peaks.push(index);
        }
    }

    deduplicate_peaks(&peaks, 1)
}

fn deduplicate_peaks(peaks: &[usize], width: usize) -> Vec<usize> {
    if peaks.is_empty() {
        return Vec::new();
    }

    let mut result = Vec::new();
    let mut position = peaks[0] as f64;
    let mut count = 1.0_f64;

    for &next_usize in &peaks[1..] {
        let next = next_usize as f64;
        if next - position <= width as f64 {
            count += 1.0;
            position += (next - position) / count;
        } else {
            result.push(position.round() as usize);
            position = next;
            count = 1.0;
        }
    }
    result.push(position.round() as usize);

    result
}

fn snap_downbeats_to_beats(beats: &[f32], downbeats: &mut Vec<f32>) {
    if beats.is_empty() || downbeats.is_empty() {
        return;
    }

    for downbeat in downbeats.iter_mut() {
        let Some(index) = nearest_beat_index(beats, *downbeat, f32::INFINITY) else {
            continue;
        };
        *downbeat = beats[index];
    }

    downbeats.sort_by(|lhs, rhs| lhs.total_cmp(rhs));
    downbeats.dedup();
}

fn nearest_beat_index(beats: &[f32], time: f32, tolerance: f32) -> Option<usize> {
    let position = beats.partition_point(|beat| *beat < time);
    let best = match (position.checked_sub(1), beats.get(position)) {
        (Some(before), Some(after)) => {
            if (time - beats[before]).abs() <= (*after - time).abs() {
                before
            } else {
                position
            }
        }
        (Some(before), None) => before,
        (None, Some(_)) => position,
        (None, None) => return None,
    };

    if (beats[best] - time).abs() <= tolerance {
        Some(best)
    } else {
        None
    }
}

/// Use the host's platform-aware directory exclusively when running in a desktop bundle.
fn bundled_model_candidates(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let bundled_model_path = PathBuf::from(BUNDLED_MODEL_PATH);
    if let Some(resource_dir) = resource_dir {
        return vec![resource_dir.join(bundled_model_path)];
    }
    let mut candidates = vec![bundled_model_path.clone()];

    if let Ok(exe_path) = std::env::current_exe()
        && let Some(exe_dir) = exe_path.parent()
    {
        candidates.push(exe_dir.join(&bundled_model_path));
        if let Some(contents_dir) = exe_dir.parent() {
            candidates.push(contents_dir.join("Resources").join(&bundled_model_path));
        }
    }

    candidates
}

/// Include every attempted location in a failed model lookup for diagnostics.
fn missing_model_message(candidates: &[PathBuf]) -> String {
    let searched = candidates
        .iter()
        .map(|candidate| candidate.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Bundled Beat This model file was not found. Searched: {}",
        searched
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Resolve an installed model from a Linux bundle layout outside the working directory.
    #[test]
    fn resolves_model_from_host_resource_directory() {
        let bundle_root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let resource_dir = bundle_root.join("usr/lib/nightfall");
        let model_path = resource_dir.join(BUNDLED_MODEL_PATH);
        std::fs::create_dir_all(model_path.parent().unwrap()).unwrap();
        std::fs::write(&model_path, b"test model resource").unwrap();

        let result = BeatThisModelPaths::resolve(Some(&resource_dir));
        std::fs::remove_dir_all(&bundle_root).unwrap();

        assert_eq!(result.unwrap().beat_model, model_path);
    }

    /// A missing packaged model reports its bundle path instead of using a development copy.
    #[test]
    fn missing_host_resource_does_not_fall_back_to_working_directory() {
        let resource_dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let model_path = resource_dir.join(BUNDLED_MODEL_PATH);
        let error = BeatThisModelPaths::resolve(Some(&resource_dir)).unwrap_err();
        assert_eq!(
            error,
            format!(
                "Bundled Beat This model file was not found. Searched: {}",
                model_path.display()
            )
        );
    }

    #[test]
    fn calculate_bpm_uses_median_interval() {
        let bpm = calculate_bpm(&[0.0, 0.5, 1.0, 1.5, 2.0]).expect("bpm");
        assert!((bpm - 120.0).abs() < 0.1);
    }

    #[test]
    fn peak_picker_deduplicates_tied_adjacent_peaks() {
        let peaks = find_peaks(&[0.0, 1.0, 1.0, 0.0]);
        assert_eq!(peaks, vec![2]);
    }

    #[test]
    fn downbeat_inference_counts_between_model_downbeats() {
        let beats = vec![0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
        let downbeats = vec![0.0, 2.0, 4.0];

        assert_eq!(infer_beats_per_bar(&beats, &downbeats), Some(4));
        assert_eq!(first_downbeat_index(&beats, &downbeats), Some(0));
    }

    #[test]
    fn chunk_start_generation_covers_short_audio() {
        assert_eq!(generate_chunk_starts(100), vec![-6]);
    }
}
