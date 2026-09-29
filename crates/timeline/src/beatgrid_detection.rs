// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Beatgrid detection request queue and result handling.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::{Duration, UNIX_EPOCH};

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use uuid::Uuid;

use crate::prelude::*;

/// One beat of a detected grid, starting at the first detected downbeat.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DetectedBeat {
    /// Beat time from the start of the audio, in seconds.
    pub time_sec: f32,
    /// Whether this beat starts a bar.
    pub is_downbeat: bool,
}

/// Beatgrid returned by a detection backend before it becomes a timeline proposal.
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedBeatgrid {
    /// Estimated tempo in beats per minute.
    pub bpm: f32,
    /// Estimated number of beats in each bar.
    pub beats_per_bar: u8,
    /// Beats from the first downbeat onwards.
    pub beats: Vec<DetectedBeat>,
    /// Overall confidence in the grid, from 0 to 1.
    pub confidence: f32,
}

/// Audio analysis backend supplied by the host application.
///
/// The timeline only schedules detection and turns results into proposals; the host provides
/// the model-backed implementation so this crate does not depend on the inference stack.
#[derive(Debug, Clone, Copy)]
pub struct BeatgridDetector {
    /// Returns whether model weights are installed, so audio imports can skip detection
    /// instead of prompting a download.
    pub model_installed: fn() -> bool,
    /// Analyzes an audio file, using the given beats per bar when the audio does not imply one.
    pub detect: fn(&Path, u8) -> Result<DetectedBeatgrid, String>,
}

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
    detector: Option<BeatgridDetector>,
    result_tx: Sender<BeatgridWorkerResult>,
    result_rx: Mutex<Receiver<BeatgridWorkerResult>>,
    pending_requests: HashMap<Uuid, PendingDetection>,
    proposals: HashMap<Uuid, BeatgridProposal>,
    proposal_timeline_uids: HashMap<Uuid, Uuid>,
}

impl BeatgridDetectionRuntime {
    /// Create the background worker result channel for the host-supplied detector, if any.
    pub(crate) fn new(detector: Option<BeatgridDetector>) -> Self {
        let (result_tx, result_rx) = mpsc::channel::<BeatgridWorkerResult>();
        Self {
            detector,
            result_tx,
            result_rx: Mutex::new(result_rx),
            pending_requests: HashMap::new(),
            proposals: HashMap::new(),
            proposal_timeline_uids: HashMap::new(),
        }
    }
}

/// Queue a beatgrid detection request for the provided timeline.
pub(crate) fn request_detection_for_timeline(
    runtime: &mut BeatgridDetectionRuntime,
    broadcaster: &ClientEventSink,
    timeline: &Timeline,
    trigger: BeatgridDetectionTrigger,
) {
    // Audio import must not trigger an unsolicited model download or a missing-model error.
    if matches!(trigger, BeatgridDetectionTrigger::Automatic)
        && !runtime
            .detector
            .is_some_and(|detector| (detector.model_installed)())
    {
        return;
    }
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

    let detector = runtime.detector;
    let worker_tx = runtime.result_tx.clone();
    let worker_task = BeatgridWorkerTask {
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
            let proposal_result = detect_beatgrid(detector, worker_task.clone());
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

/// Run the host's detector on the requested audio and convert its grid into a timeline proposal.
fn detect_beatgrid(
    detector: Option<BeatgridDetector>,
    task: BeatgridWorkerTask,
) -> Result<BeatgridProposal, String> {
    let detector =
        detector.ok_or_else(|| "Beatgrid detection is not available in this build".to_string())?;
    let grid = (detector.detect)(&task.audio_path, task.beats_per_bar)?;
    let confidence = grid.confidence;
    let markers = grid
        .beats
        .iter()
        .enumerate()
        .map(|(index, beat)| BeatMarker {
            time: Duration::from_millis((beat.time_sec * 1000.0).round().max(0.0) as u64),
            beat_index: index as u32,
            is_downbeat: beat.is_downbeat,
            confidence: Some(confidence),
        })
        .collect();

    Ok(BeatgridProposal {
        request_id: task.request_id,
        source: task.source,
        audio_fingerprint: task.audio_fingerprint,
        bpm: grid.bpm,
        beats_per_bar: grid.beats_per_bar,
        markers,
        confidence,
    })
}

/// Fingerprint an audio file by path, size, and modification time to detect replaced audio.
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
