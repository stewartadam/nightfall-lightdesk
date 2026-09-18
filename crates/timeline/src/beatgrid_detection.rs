// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Beatgrid detection request queue and result handling.

#[cfg(feature = "beatgrid-detect")]
use std::cmp::Ordering;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::UNIX_EPOCH;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use uuid::Uuid;

use crate::prelude::*;

/// Trigger source for a beatgrid detection request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BeatgridDetectionTrigger {
    /// Triggered automatically when audio changes.
    Automatic,
    /// Triggered explicitly by user request.
    Manual,
}

/// Queued beatgrid detection request awaiting worker completion.
#[derive(Debug, Clone)]
struct PendingDetection {
    timeline_uid: Uuid,
    audio_fingerprint: String,
}

/// Async task handle for an in-flight beatgrid detection request.
#[derive(Debug, Clone)]
struct BeatgridWorkerTask {
    #[cfg(feature = "beatgrid-detect")]
    resource_dir: Option<PathBuf>,
    request_id: Uuid,
    timeline_uid: Uuid,
    source: BeatgridSource,
    audio_fingerprint: String,
    audio_path: PathBuf,
    beats_per_bar: u8,
}

/// Completed beatgrid detection output waiting to be applied to the timeline.
#[derive(Debug, Clone)]
struct BeatgridWorkerResult {
    request_id: Uuid,
    timeline_uid: Uuid,
    proposal_result: Result<BeatgridProposal, String>,
}

/// Runtime state for background beatgrid detection and pending proposals.
#[derive(Resource)]
pub(crate) struct BeatgridDetectionRuntime {
    #[cfg(feature = "beatgrid-detect")]
    resource_dir: Option<PathBuf>,
    result_tx: Sender<BeatgridWorkerResult>,
    result_rx: Mutex<Receiver<BeatgridWorkerResult>>,
    pending_requests: HashMap<Uuid, PendingDetection>,
    proposals: HashMap<Uuid, BeatgridProposal>,
    proposal_timeline_uids: HashMap<Uuid, Uuid>,
}

impl FromWorld for BeatgridDetectionRuntime {
    /// Capture host resource configuration and create the background worker result channel.
    fn from_world(_world: &mut World) -> Self {
        let (result_tx, result_rx) = mpsc::channel::<BeatgridWorkerResult>();
        Self {
            #[cfg(feature = "beatgrid-detect")]
            resource_dir: _world
                .get_resource::<crate::beat_this_detection::BeatThisResourceDirectory>()
                .and_then(|directory| directory.0.clone()),
            result_tx,
            result_rx: Mutex::new(result_rx),
            pending_requests: HashMap::new(),
            proposals: HashMap::new(),
            proposal_timeline_uids: HashMap::new(),
        }
    }
}

/// Verify the worker runtime keeps the desktop resource location supplied to its world.
#[cfg(all(test, feature = "beatgrid-detect"))]
#[test]
fn detection_runtime_inherits_host_resource_directory() {
    let resource_dir = PathBuf::from("/opt/nightfall/usr/lib/nightfall");
    let mut world = World::new();
    world.insert_resource(crate::beat_this_detection::BeatThisResourceDirectory(Some(
        resource_dir.clone(),
    )));
    world.init_resource::<BeatgridDetectionRuntime>();

    assert_eq!(
        world.resource::<BeatgridDetectionRuntime>().resource_dir,
        Some(resource_dir)
    );
}

/// Queue a beatgrid detection request for the provided timeline.
pub(crate) fn request_detection_for_timeline(
    runtime: &mut BeatgridDetectionRuntime,
    broadcaster: &ClientEventSink,
    timeline: &Timeline,
    trigger: BeatgridDetectionTrigger,
) {
    let request_id = Uuid::new_v4();
    let timeline_uid = timeline.identifiers.uid;

    if timeline.audio_path.trim().is_empty() {
        crate::websocket::broadcast_beatgrid_detection_failed(
            broadcaster,
            &BeatgridDetectionFailed {
                timeline_uid,
                request_id,
                error: "Timeline has no audio file".to_string(),
            },
        );
        return;
    }

    let absolute_audio_path =
        match crate::storage::resolve_timeline_audio_path(&timeline.audio_path) {
            Ok(path) => path,
            Err(error) => {
                crate::websocket::broadcast_beatgrid_detection_failed(
                    broadcaster,
                    &BeatgridDetectionFailed {
                        timeline_uid,
                        request_id,
                        error,
                    },
                );
                return;
            }
        };
    if !absolute_audio_path.exists() {
        crate::websocket::broadcast_beatgrid_detection_failed(
            broadcaster,
            &BeatgridDetectionFailed {
                timeline_uid,
                request_id,
                error: format!(
                    "Audio file does not exist: {}",
                    absolute_audio_path.to_string_lossy()
                ),
            },
        );
        return;
    }

    let audio_fingerprint = match compute_audio_fingerprint(&absolute_audio_path) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            crate::websocket::broadcast_beatgrid_detection_failed(
                broadcaster,
                &BeatgridDetectionFailed {
                    timeline_uid,
                    request_id,
                    error,
                },
            );
            return;
        }
    };

    if matches!(trigger, BeatgridDetectionTrigger::Automatic) {
        if timeline
            .beatgrid
            .as_ref()
            .is_some_and(|grid| grid.audio_fingerprint == audio_fingerprint)
        {
            return;
        }

        let has_matching_pending_request = runtime.pending_requests.values().any(|pending| {
            pending.timeline_uid == timeline_uid && pending.audio_fingerprint == audio_fingerprint
        });
        if has_matching_pending_request {
            return;
        }
    }

    let source = match trigger {
        BeatgridDetectionTrigger::Automatic => BeatgridSource::Auto,
        BeatgridDetectionTrigger::Manual => BeatgridSource::Manual,
    };
    let beats_per_bar = timeline.beats_per_bar.max(1);

    runtime.pending_requests.insert(
        request_id,
        PendingDetection {
            timeline_uid,
            audio_fingerprint: audio_fingerprint.clone(),
        },
    );

    crate::websocket::broadcast_beatgrid_detection_started(
        broadcaster,
        &BeatgridDetectionStarted {
            timeline_uid,
            request_id,
        },
    );

    let worker_tx = runtime.result_tx.clone();
    let worker_task = BeatgridWorkerTask {
        #[cfg(feature = "beatgrid-detect")]
        resource_dir: runtime.resource_dir.clone(),
        request_id,
        timeline_uid,
        source,
        audio_fingerprint,
        audio_path: absolute_audio_path,
        beats_per_bar,
    };

    let spawn_result = std::thread::Builder::new()
        .name(format!("timeline-beatgrid-{}", request_id))
        .spawn(move || {
            let proposal_result = detect_beatgrid(worker_task.clone());
            let _ = worker_tx.send(BeatgridWorkerResult {
                request_id: worker_task.request_id,
                timeline_uid: worker_task.timeline_uid,
                proposal_result,
            });
        });

    if let Err(error) = spawn_result {
        runtime.pending_requests.remove(&request_id);
        crate::websocket::broadcast_beatgrid_detection_failed(
            broadcaster,
            &BeatgridDetectionFailed {
                timeline_uid,
                request_id,
                error: format!("Failed to spawn beatgrid worker thread: {}", error),
            },
        );
    }
}

/// Poll worker results and broadcast ready/failed websocket events.
pub(crate) fn process_detection_results_system(
    mut runtime: ResMut<BeatgridDetectionRuntime>,
    broadcaster: Res<ClientEventSink>,
) {
    loop {
        let result = {
            let lock_result = runtime.result_rx.lock();
            let Ok(receiver) = lock_result else {
                tracing::error!("Beatgrid detection receiver mutex poisoned");
                return;
            };
            receiver.try_recv()
        };

        let worker_result = match result {
            Ok(worker_result) => worker_result,
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                tracing::error!("Beatgrid detection worker channel disconnected");
                break;
            }
        };

        runtime.pending_requests.remove(&worker_result.request_id);

        match worker_result.proposal_result {
            Ok(proposal) => {
                runtime
                    .proposal_timeline_uids
                    .insert(worker_result.request_id, worker_result.timeline_uid);
                runtime
                    .proposals
                    .insert(worker_result.request_id, proposal.clone());
                crate::websocket::broadcast_beatgrid_detection_ready(
                    &broadcaster,
                    &BeatgridDetectionReady {
                        timeline_uid: worker_result.timeline_uid,
                        proposal,
                    },
                );
            }
            Err(error) => {
                crate::websocket::broadcast_beatgrid_detection_failed(
                    &broadcaster,
                    &BeatgridDetectionFailed {
                        timeline_uid: worker_result.timeline_uid,
                        request_id: worker_result.request_id,
                        error,
                    },
                );
            }
        }
    }
}

/// Return a stored proposal for a request if it belongs to the provided timeline.
pub(crate) fn get_proposal_for_timeline(
    runtime: &BeatgridDetectionRuntime,
    timeline_uid: Uuid,
    request_id: Uuid,
) -> Option<BeatgridProposal> {
    if runtime.proposal_timeline_uids.get(&request_id).copied()? != timeline_uid {
        return None;
    }
    runtime.proposals.get(&request_id).cloned()
}

/// Remove and return a stored proposal for a request if it belongs to the provided timeline.
pub(crate) fn take_proposal_for_timeline(
    runtime: &mut BeatgridDetectionRuntime,
    timeline_uid: Uuid,
    request_id: Uuid,
) -> Option<BeatgridProposal> {
    if runtime.proposal_timeline_uids.get(&request_id).copied()? != timeline_uid {
        return None;
    }
    runtime.proposal_timeline_uids.remove(&request_id);
    runtime.proposals.remove(&request_id)
}

#[cfg(feature = "beatgrid-detect")]
/// Analyze the requested audio using the model from the host's resource directory.
fn detect_beatgrid(task: BeatgridWorkerTask) -> Result<BeatgridProposal, String> {
    use std::time::Duration;

    let model_paths =
        crate::beat_this_detection::BeatThisModelPaths::resolve(task.resource_dir.as_deref())?;
    let analysis = crate::beat_this_detection::analyze_path(&task.audio_path, &model_paths)?;

    if analysis.beats.len() < 2 {
        return Err("Could not detect enough beats in audio".to_string());
    }

    let first_downbeat_index =
        crate::beat_this_detection::first_downbeat_index(&analysis.beats, &analysis.downbeats)
            .unwrap_or(0);
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

    let bpm = crate::beat_this_detection::calculate_bpm(beat_times_sec)
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

    let beats_per_bar =
        crate::beat_this_detection::infer_beats_per_bar(&analysis.beats, &analysis.downbeats)
            .unwrap_or(task.beats_per_bar)
            .max(1);
    let markers = beat_times_sec
        .iter()
        .copied()
        .enumerate()
        .map(|(index, beat_sec)| BeatMarker {
            time: Duration::from_millis((beat_sec * 1000.0).round().max(0.0) as u64),
            beat_index: index as u32,
            is_downbeat: crate::beat_this_detection::is_model_downbeat(
                beat_sec,
                &analysis.downbeats,
            ) || index % usize::from(beats_per_bar) == 0,
            confidence: Some(confidence),
        })
        .collect();

    Ok(BeatgridProposal {
        request_id: task.request_id,
        source: task.source,
        audio_fingerprint: task.audio_fingerprint,
        bpm,
        beats_per_bar,
        markers,
        confidence,
    })
}

#[cfg(not(feature = "beatgrid-detect"))]
fn detect_beatgrid(task: BeatgridWorkerTask) -> Result<BeatgridProposal, String> {
    let _ = (
        task.source,
        task.audio_fingerprint,
        task.audio_path,
        task.beats_per_bar,
    );
    Err("Beatgrid detection backend is disabled (enable feature `beatgrid-detect`)".to_string())
}

fn compute_audio_fingerprint(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Failed to read audio metadata: {}", error))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    Ok(format!("{:x}", hasher.finish()))
}

#[cfg(feature = "beatgrid-detect")]
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

#[cfg(feature = "beatgrid-detect")]
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

#[cfg(feature = "beatgrid-detect")]
fn compute_model_peak_confidence(beat_logits: &[f32], downbeat_logits: &[f32]) -> f32 {
    let beat_confidence = positive_logit_confidence(beat_logits);
    let downbeat_confidence = positive_logit_confidence(downbeat_logits);
    (beat_confidence * 0.75 + downbeat_confidence * 0.25).clamp(0.0, 1.0)
}

#[cfg(feature = "beatgrid-detect")]
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
